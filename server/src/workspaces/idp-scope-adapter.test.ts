import { describe, expect, test } from "bun:test";
import { env, overrideEnv } from "../env";
import { createIdpContentReaderScopeAdapter, createIdpTokenScopeAdapter } from "./idp-scope-adapter";

describe("IdP token scope adapter", () => {
  test("exchanges user subject_token with confidential client credentials", async () => {
    const previousEnv = { ...env };
    const previousFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];

    try {
      overrideEnv({
        IDP_SCOPE_API_URL: "https://idp.example.test/t/ck/scope",
        OIDC_CLIENT_ID: "web-client",
        OIDC_CLIENT_SECRET: "server-secret",
      });
      globalThis.fetch = (async (url, init) => {
        requests.push({
          url: url.toString(),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });

        return new Response(
          JSON.stringify({
            access_token: "scoped-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const result = await createIdpTokenScopeAdapter().updateUserScope({
        subjectToken: "current-user-token",
        scope: { db: "ws_beta", ac: "participant" },
      });

      expect(result).toEqual({ accessToken: "scoped-access-token", expiresIn: 3600 });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://idp.example.test/t/ck/scope");
      expect(requests[0]?.headers.get("authorization")).toBe(
        `Basic ${btoa("web-client:server-secret")}`,
      );
      expect(requests[0]?.body).toEqual({
        subject_token: "current-user-token",
        claims: {
          db: "ws_beta",
          ac: "participant",
          RL: ["Editor"],
        },
      });
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });

  test("失败响应体里的 token / secret 值不会进入 error message", async () => {
    const previousEnv = { ...env };
    const previousFetch = globalThis.fetch;

    try {
      overrideEnv({
        IDP_SCOPE_API_URL: "https://idp.example.test/t/ck/scope",
        OIDC_CLIENT_ID: "web-client",
        OIDC_CLIENT_SECRET: "server-secret",
      });
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            subject_token: "echoed-subject-token",
            access_token: "leaked-access-token",
            id_token: "leaked-id-token",
            client_secret: "leaked-client-secret",
            detail: { refresh_token: "leaked-refresh-token" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )) as typeof fetch;

      expect.assertions(8);
      try {
        await createIdpTokenScopeAdapter().updateUserScope({
          subjectToken: "current-user-token",
          scope: { db: "ws_beta", ac: "participant" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("400");
        expect(message).toContain("invalid_grant");
        expect(message).not.toContain("current-user-token");
        expect(message).not.toContain("echoed-subject-token");
        expect(message).not.toContain("leaked-access-token");
        expect(message).not.toContain("leaked-id-token");
        expect(message).not.toContain("leaked-client-secret");
        expect(message).not.toContain("leaked-refresh-token");
      }
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });

  test("content_reader scope 走同一 scope 端点且不带 RL", async () => {
    const previousEnv = { ...env };
    const previousFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];

    try {
      overrideEnv({
        IDP_SCOPE_API_URL: "https://idp.example.test/t/ck/scope",
        OIDC_CLIENT_ID: "web-client",
        OIDC_CLIENT_SECRET: "server-secret",
      });
      globalThis.fetch = (async (url, init) => {
        requests.push({
          url: url.toString(),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({ access_token: "reader-token", expires_in: 120, token_type: "Bearer", scope: "openid profile" }),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }) as typeof fetch;

      const result = await createIdpContentReaderScopeAdapter().exchangeContentReaderScope({
        subjectToken: "current-user-token",
        database: "platform_content",
        workspaceId: "ws_alpha",
        entitlementRevision: "7",
        leaseEndSeconds: 1780000900,
      });

      expect(result).toEqual({ accessToken: "reader-token", expiresIn: 120 });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://idp.example.test/t/ck/scope");
      expect(requests[0]?.headers.get("authorization")).toBe(`Basic ${btoa("web-client:server-secret")}`);
      expect(requests[0]?.body).toEqual({
        subject_token: "current-user-token",
        claims: {
          ac: "content_reader",
          db: "platform_content",
          workspace_id: "ws_alpha",
          entitlement_revision: "7",
          lease_end: 1780000900,
        },
      });
      expect(JSON.stringify(requests[0]?.body)).not.toContain("RL");
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });

  test("content_reader scope 失败返回契约错误码而不是抛错", async () => {
    const previousEnv = { ...env };
    const previousFetch = globalThis.fetch;
    try {
      overrideEnv({
        IDP_SCOPE_API_URL: "https://idp.example.test/t/ck/scope",
        OIDC_CLIENT_ID: "web-client",
        OIDC_CLIENT_SECRET: "server-secret",
      });
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 })) as typeof fetch;
      const result = await createIdpContentReaderScopeAdapter().exchangeContentReaderScope({
        subjectToken: "t", database: "platform_content", workspaceId: "ws_a",
        entitlementRevision: "7", leaseEndSeconds: 1780000900,
      });
      expect(result).toEqual({ error: "invalid_scope" });
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });

  test("admin scope 下发 OWNER roles claim", async () => {
    const previousEnv = { ...env };
    const previousFetch = globalThis.fetch;
    const requests: Array<{ body: unknown }> = [];

    try {
      overrideEnv({
        IDP_SCOPE_API_URL: "https://idp.example.test/t/ck/scope",
        OIDC_CLIENT_ID: "web-client",
        OIDC_CLIENT_SECRET: "server-secret",
      });
      globalThis.fetch = (async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ access_token: "scoped-access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      await createIdpTokenScopeAdapter().updateUserScope({
        subjectToken: "current-user-token",
        scope: { db: "ws_alpha", ac: "admin" },
      });

      expect(requests[0]?.body).toEqual({
        subject_token: "current-user-token",
        claims: {
          db: "ws_alpha",
          ac: "admin",
          RL: ["Owner"],
        },
      });
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });
});
