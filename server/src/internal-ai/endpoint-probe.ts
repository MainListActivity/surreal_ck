import { randomUUID } from "node:crypto";

/**
 * FV06 受控目录认证探针（零推理、默认关闭）。
 *
 * 固定目标、固定方法：只用服务进程自己持有的产品身份对固定目录端点发 `GET /models`。
 * 不接受调用方提供的 key / URL / header / 模型 / 请求体；不读 env 文件；
 * 不重试、不跟随重定向、不访问任何对话/补全/embedding 端点。
 *
 * 200 只说明「该身份在该端点可读目录」，不证明 `group/work` 推理权限、免费计费或流式兼容。
 * 其余一切结果（含未知）都不放行窗口，也不据此推断凭证类型。
 */
export const ENDPOINT_PROBE_TARGET = Object.freeze({
  endpoint: "https://data.maplayer.top/ofm/v1",
  host: "data.maplayer.top",
  path: "/ofm/v1",
  modelsUrl: "https://data.maplayer.top/ofm/v1/models",
});

export const ENDPOINT_PROBE_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  maxConcurrent: 1,
  minIntervalMs: 60_000,
});

export type EndpointProbeErrorType =
  | "not-configured"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "timeout"
  | "connection-failed"
  | "redirected"
  | "invalid-json"
  | "response-too-large"
  | "unexpected-catalog"
  | "unexpected-status";

/** catalog-readable 只表示目录可读；rejected 表示确定的拒绝；unknown 表示无法判定。 */
export type EndpointProbeStatus = "catalog-readable" | "rejected" | "unknown";

export type EndpointProbeResult = Readonly<{
  endpointHost: string;
  endpointPath: string;
  checkedAt: string;
  status: EndpointProbeStatus;
  errorType: EndpointProbeErrorType | null;
  latencyMs: number;
  requestId: string;
}>;

export type EndpointProbeRunInput = Readonly<{
  /** 服务进程自己持有的产品身份；缺省即 not-configured，绝不回落到调用方输入。 */
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestId?: () => string;
}>;

const rejected = (errorType: EndpointProbeErrorType): EndpointProbeStatus =>
  errorType === "unexpected-catalog" || errorType === "invalid-json" ? "unknown" : "rejected";

function statusForHttpCode(code: number): EndpointProbeErrorType {
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 429) return "rate-limited";
  return "unexpected-status";
}

/** 目录内容必须是非空的 `{ data: [{ id: string, ... }] }`；否则视为内容不符，不放行。 */
function catalogModelCount(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  for (const entry of data) {
    if (!entry || typeof entry !== "object") return null;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) return null;
  }
  return data.length;
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function runEndpointProbe(input: EndpointProbeRunInput): Promise<EndpointProbeResult> {
  const now = input.now ?? (() => Date.now());
  const requestId = (input.requestId ?? (() => randomUUID()))();
  const fetchImpl = input.fetchImpl ?? fetch;
  const started = now();
  const base = {
    endpointHost: ENDPOINT_PROBE_TARGET.host,
    endpointPath: ENDPOINT_PROBE_TARGET.path,
    requestId,
  } as const;
  const finish = (status: EndpointProbeStatus, errorType: EndpointProbeErrorType | null): EndpointProbeResult => ({
    ...base,
    checkedAt: new Date(started).toISOString(),
    status,
    errorType,
    latencyMs: Math.max(0, now() - started),
  });

  if (!input.apiKey || input.apiKey.trim().length === 0) return finish("unknown", "not-configured");

  // 单次请求、固定目标、不跟随重定向；超时只由本模块的固定上限控制。
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT_PROBE_TARGET.modelsUrl, {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(ENDPOINT_PROBE_LIMITS.timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return finish("unknown", name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection-failed");
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return finish("rejected", "redirected");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    const errorType = statusForHttpCode(response.status);
    return finish(rejected(errorType), errorType);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(response.body, ENDPOINT_PROBE_LIMITS.maxResponseBytes);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return finish("unknown", name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection-failed");
  }
  if (bytes === null) return finish(rejected("response-too-large"), "response-too-large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return finish("unknown", "invalid-json");
  }
  if (catalogModelCount(parsed) === null) return finish("unknown", "unexpected-catalog");
  return finish("catalog-readable", null);
}

/**
 * 进程内限流：同一时刻最多一次探测，且两次探测之间至少间隔 `minIntervalMs`。
 * 单实例部署下这是全局上限；多实例各自限流，不作为安全边界。
 */
export type EndpointProbeLease = "ok" | "busy" | "throttled";

export function createEndpointProbeLimiter(options: Readonly<{ maxConcurrent?: number; minIntervalMs?: number; now?: () => number }> = {}) {
  const maxConcurrent = options.maxConcurrent ?? ENDPOINT_PROBE_LIMITS.maxConcurrent;
  const minIntervalMs = options.minIntervalMs ?? ENDPOINT_PROBE_LIMITS.minIntervalMs;
  const now = options.now ?? (() => Date.now());
  let active = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return {
    tryAcquire(): EndpointProbeLease {
      if (active >= maxConcurrent) return "busy";
      const at = now();
      if (at - lastStartedAt < minIntervalMs) return "throttled";
      active += 1;
      lastStartedAt = at;
      return "ok";
    },
    release(): void {
      active = Math.max(0, active - 1);
    },
  };
}

export type EndpointProbeLimiter = ReturnType<typeof createEndpointProbeLimiter>;
