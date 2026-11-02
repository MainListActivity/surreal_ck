import { describe, expect, test } from "bun:test";
import { createEndpointProbeLimiter, ENDPOINT_PROBE_LIMITS, ENDPOINT_PROBE_TARGET, endpointProbeInternalErrorResult, probeErrorName, runEndpointProbe } from "./endpoint-probe";

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const catalog = (ids: string[]) => Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });

describe("endpoint probe core", () => {
  test("没有进程内身份时不发请求，返回 not-configured", async () => {
    const { fn, calls } = mockFetch(() => catalog(["group/work"]));
    for (const apiKey of [undefined, "", "   "]) {
      const result = await runEndpointProbe({ apiKey, fetchImpl: fn });
      expect(result.status).toBe("unknown");
      expect(result.errorType).toBe("not-configured");
    }
    expect(calls).toHaveLength(0);
  });

  test("固定目标 GET /models：不跟随重定向、不重试、只发一次、凭证只在 Authorization", async () => {
    const { fn, calls } = mockFetch(() => catalog(["group/work", "group/other"]));
    const result = await runEndpointProbe({ apiKey: "synthetic-probe-key", fetchImpl: fn });
    expect(result.status).toBe("catalog-readable");
    expect(result.errorType).toBeNull();
    expect(result.endpointHost).toBe("data.maplayer.top");
    expect(result.endpointPath).toBe("/ofm/v1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT_PROBE_TARGET.modelsUrl);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.redirect).toBe("manual");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer synthetic-probe-key");
    expect(headers.accept).toBe("application/json");
    expect(Object.keys(headers).sort()).toEqual(["accept", "authorization"]);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  test("返回体只含受控字段，不含凭证明文或上游原文", async () => {
    const { fn } = mockFetch(() => catalog(["group/work"]));
    const result = await runEndpointProbe({ apiKey: "synthetic-probe-key", fetchImpl: fn, requestId: () => "req-fixed" });
    expect(Object.keys(result).sort()).toEqual(["checkedAt", "endpointHost", "endpointPath", "errorType", "latencyMs", "requestId", "status"]);
    expect(result.requestId).toBe("req-fixed");
    expect(JSON.stringify(result)).not.toContain("synthetic-probe-key");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  test("401/403/429 分别映射为 unauthorized/forbidden/rate-limited，且不回显上游错误正文", async () => {
    const cases: Array<[number, string]> = [[401, "unauthorized"], [403, "forbidden"], [429, "rate-limited"], [500, "unexpected-status"]];
    for (const [code, expected] of cases) {
      const { fn } = mockFetch(() => new Response(JSON.stringify({ error: "LEAK-MARKER-upstream-body" }), { status: code }));
      const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: fn });
      expect(result.status).toBe("rejected");
      expect(result.errorType).toBe(expected as never);
      expect(JSON.stringify(result)).not.toContain("LEAK-MARKER");
    }
  });

  test("3xx 一律视为重定向，绝不跟随", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/v1/models" } }));
    const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: fn });
    expect(result.status).toBe("rejected");
    expect(result.errorType).toBe("redirected");
    expect(calls).toHaveLength(1);
  });

  test("非 JSON 与不符预期的目录都不放行", async () => {
    const invalidJson = mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    expect((await runEndpointProbe({ apiKey: "synthetic", fetchImpl: invalidJson.fn })).errorType).toBe("invalid-json");

    for (const payload of [{ data: [] }, { data: [{ id: "" }] }, { data: "x" }, { models: [] }, null]) {
      const { fn } = mockFetch(() => Response.json(payload));
      const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: fn });
      expect(result.status).toBe("unknown");
      expect(result.errorType).toBe("unexpected-catalog");
    }
  });

  test("超过响应大小上限即中断并返回 response-too-large", async () => {
    const chunk = new Uint8Array(8 * 1024).fill(0x20);
    const { fn } = mockFetch(() => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 16; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: fn });
    expect(result.status).toBe("rejected");
    expect(result.errorType).toBe("response-too-large");
    expect(ENDPOINT_PROBE_LIMITS.maxResponseBytes).toBeLessThan(16 * chunk.byteLength);
  });

  test("超时与连接失败都归为 unknown，不放行", async () => {
    const timeout = mockFetch(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    expect(await runEndpointProbe({ apiKey: "synthetic", fetchImpl: timeout.fn })).toMatchObject({ status: "unknown", errorType: "timeout" });

    const refused = mockFetch(() => { throw new TypeError("fetch failed"); });
    expect(await runEndpointProbe({ apiKey: "synthetic", fetchImpl: refused.fn })).toMatchObject({ status: "unknown", errorType: "connection-failed" });
  });

  // round-01 问题 1：200 空正文不是超限，应归为不符合目录的 invalid-json，且不放行。
  test("200 空正文归为 invalid-json，而不是 response-too-large", async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: fn });
    expect(result.status).toBe("unknown");
    expect(result.errorType).toBe("invalid-json");
  });

  // round-01 问题 1 的对照：超限仍然是 response-too-large，两者不能混用。
  test("超限与空正文分开计数，超限仍报 response-too-large", async () => {
    const big = mockFetch(() => new Response(new Uint8Array(ENDPOINT_PROBE_LIMITS.maxResponseBytes + 1), { status: 200 }));
    expect(await runEndpointProbe({ apiKey: "synthetic", fetchImpl: big.fn })).toMatchObject({ status: "rejected", errorType: "response-too-large" });
  });

  // 真实套接字：服务端发出 200 响应头后挂起正文，验证探针在固定 5 秒上限内返回 timeout，而不是无限等待。
  // 测试超时长于探针上限，避免与 bun 默认 5 秒测试超时竞争；探针实现不改。
  test("正文挂起时按固定上限返回 timeout（真实套接字）", async () => {
    const hold = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
        });
        return new Response(stalled, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const realFetch = (url: string | URL | Request, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${hold.port}/v1/models`, init);
      const started = Date.now();
      const result = await runEndpointProbe({ apiKey: "synthetic", fetchImpl: realFetch as unknown as typeof fetch });
      const elapsed = Date.now() - started;
      expect(result.status).toBe("unknown");
      expect(result.errorType).toBe("timeout");
      expect(elapsed).toBeGreaterThanOrEqual(ENDPOINT_PROBE_LIMITS.timeoutMs - 250);
      expect(elapsed).toBeLessThan(ENDPOINT_PROBE_LIMITS.timeoutMs + 3_000);
    } finally {
      hold.stop(true);
    }
  }, 15_000);

  test("探针错误类名白名单：标准名称保留，其它一律 other，消息不进入结果", () => {
    expect(probeErrorName(new TypeError("fetch failed"))).toBe("TypeError");
    expect(probeErrorName(Object.assign(new Error("secret-bearing"), { name: "Bearer synthetic-probe-key" }))).toBe("other");
    expect(probeErrorName("plain string")).toBe("other");
  });

  test("未预期异常的受控结果不携带消息或栈", () => {
    const result = endpointProbeInternalErrorResult({ startedAt: 1_000, now: () => 1_010, requestId: () => "req-internal" });
    expect(result).toMatchObject({ status: "unknown", errorType: "internal-error", latencyMs: 10, requestId: "req-internal" });
    expect(JSON.stringify(result)).not.toMatch(/stack|message|Bearer/u);
  });


  test("限流：同一时刻只允许一次，两次之间需要冷却", () => {
    let clock = 1_000;
    const limiter = createEndpointProbeLimiter({ maxConcurrent: 1, minIntervalMs: 60_000, now: () => clock });
    expect(limiter.tryAcquire()).toBe("ok");
    expect(limiter.tryAcquire()).toBe("busy");
    limiter.release();
    expect(limiter.tryAcquire()).toBe("throttled");
    clock += 60_000;
    expect(limiter.tryAcquire()).toBe("ok");
    limiter.release();
  });
});
