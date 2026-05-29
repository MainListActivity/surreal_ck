import { describe, expect, test } from "bun:test";
import { createApiClient, OidcExpiredError } from "./api";

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(handler: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseUrl = "http://api.test";

describe("API client", () => {
  test("api.chat.$post 携带 Authorization 并推导出 { runId, streamUrl, streamToken }", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ runId: "r1", streamUrl: "/api/chat/stream?runId=r1", streamToken: "tok" }),
    );
    const client = createApiClient({ baseUrl, getToken: () => "raw.jwt", fetch: fetchImpl });

    const res = await client.api.api.chat.$post({ json: { message: "hi" } });
    const data = await res.json();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api.test/api/chat");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer raw.jwt");
    // 类型推导：data 必须是 { runId; streamUrl; streamToken }
    expect(data).toEqual({ runId: "r1", streamUrl: "/api/chat/stream?runId=r1", streamToken: "tok" });
  });

  test("401 时抛 OidcExpiredError 供上层触发 refresh / 重登", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const client = createApiClient({ baseUrl, getToken: () => "expired.jwt", fetch: fetchImpl });

    const attempt = client.api.api.session.workspaces.$get();
    await expect(attempt).rejects.toBeInstanceOf(OidcExpiredError);
  });

  test("/health 等公开 endpoint 不带 Authorization", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ status: "ok" }));
    const client = createApiClient({ baseUrl, getToken: () => "raw.jwt", fetch: fetchImpl });

    await client.api.health.$get();

    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].init?.headers).has("Authorization")).toBe(false);
  });
});
