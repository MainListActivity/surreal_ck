// IdP 上游请求的超时与失败诊断。
// 诊断只保留错误名与 undici 的 cause.code，不保留 message：上游 message 可能回显 token 或 secret。

/** 单次 IdP 上游请求的总超时。实测正常响应约 6 秒，超过此值视为超时。 */
export const IDP_UPSTREAM_TIMEOUT_MS = 10_000;

const TIMEOUT_CAUSE_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// 上游超时的错误名：AbortSignal.timeout 抛 TimeoutError；jose 把 JWKS 拉取
// 超时包装成 JWKSTimeout（fetch 失败原样透传 TypeError + cause.code）。
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TimeoutError",
  "JWKSTimeout",
]);

export type UpstreamFailure = {
  name: string;
  causeCode: string | null;
  timeout: boolean;
};

export function describeUpstreamFailure(error: unknown): UpstreamFailure {
  if (typeof error !== "object" || error === null) {
    return { name: typeof error, causeCode: null, timeout: false };
  }

  const name = typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "unknown";
  // undici 把错误码放在 cause.code（fetch failed → UND_ERR_*）；Node 网络层
  // 错误可能直接带 code（ECONNRESET/ECONNREFUSED）。两层都读。
  const cause = (error as { cause?: unknown }).cause;
  const causeCode
    = (typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : null)
    ?? (typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null);

  return {
    name,
    causeCode,
    timeout: TIMEOUT_ERROR_NAMES.has(name) || (causeCode !== null && TIMEOUT_CAUSE_CODES.has(causeCode)),
  };
}

/**
 * 仅用于幂等的 scope exchange：网络层失败（超时或 fetch 网络错误）时有限重试；
 * HTTP 响应（含 4xx / 5xx）原样返回，由调用方处理。
 * 不可用于 /api/auth/token：授权码一次性，重放必然失败。
 */
export async function fetchIdempotentIdpRequest(url: string, init: RequestInit, attempts = 2): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(IDP_UPSTREAM_TIMEOUT_MS) });
    } catch (error) {
      const failure = describeUpstreamFailure(error);
      const networkFailure = failure.timeout || failure.name === "TypeError";
      if (attempt >= attempts || !networkFailure) {
        throw error;
      }
    }
  }
}
