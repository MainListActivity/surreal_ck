import { describe, expect, test } from "bun:test";
import { describeUpstreamFailure, fetchIdempotentIdpRequest } from "./upstream-fetch";

function connectTimeoutError(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect timed out with secret-value"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
}

describe("describeUpstreamFailure", () => {
  test("undici connect 超时识别为 timeout，只保留错误名与 cause.code", () => {
    expect(describeUpstreamFailure(connectTimeoutError())).toEqual({
      name: "TypeError",
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
      timeout: true,
    });
  });

  test("AbortSignal 超时（TimeoutError）识别为 timeout", () => {
    expect(describeUpstreamFailure(new DOMException("timed out", "TimeoutError"))).toEqual({
      name: "TimeoutError",
      causeCode: null,
      timeout: true,
    });
  });

  test("顶层 code（Node 网络层 ECONNRESET 等）读为 causeCode", () => {
    expect(
      describeUpstreamFailure(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" })),
    ).toEqual({ name: "Error", causeCode: "ECONNRESET", timeout: false });
  });

  test("jose JWKS 拉取超时（JWKSTimeout）识别为 timeout", () => {
    expect(describeUpstreamFailure(new DOMException("JWKS request timed out", "JWKSTimeout"))).toEqual({
      name: "JWKSTimeout",
      causeCode: null,
      timeout: true,
    });
  });

  test("普通错误不是 timeout，且不回显 message", () => {
    const failure = describeUpstreamFailure(new Error("leaked token abc"));
    expect(failure).toEqual({ name: "Error", causeCode: null, timeout: false });
    expect(JSON.stringify(failure)).not.toContain("abc");
  });

  test("非对象错误只返回类型名", () => {
    expect(describeUpstreamFailure("raw string")).toEqual({ name: "string", causeCode: null, timeout: false });
  });
});

describe("fetchIdempotentIdpRequest", () => {
  test("网络层超时后重试一次并返回成功响应", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) throw connectTimeoutError();
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const response = await fetchIdempotentIdpRequest("https://idp.example.test/scope", { method: "POST" });

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("HTTP 错误响应不重试，原样返回", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 });
      }) as typeof fetch;

      const response = await fetchIdempotentIdpRequest("https://idp.example.test/scope", { method: "POST" });

      expect(response.status).toBe(400);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("重试仍失败时抛出错误，总共尝试两次", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        throw connectTimeoutError();
      }) as typeof fetch;

      await expect(fetchIdempotentIdpRequest("https://idp.example.test/scope", { method: "POST" })).rejects.toThrow(
        "fetch failed",
      );
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("每次尝试都携带超时 signal", async () => {
    const previousFetch = globalThis.fetch;
    const signals: Array<AbortSignal | null | undefined> = [];
    try {
      globalThis.fetch = (async (_url, init) => {
        signals.push(init?.signal);
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      await fetchIdempotentIdpRequest("https://idp.example.test/scope", { method: "POST" });

      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
