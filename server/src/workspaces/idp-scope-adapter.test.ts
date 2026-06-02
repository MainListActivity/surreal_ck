import { describe, expect, test } from "bun:test";
import { env, overrideEnv } from "../env";
import { createIdpTokenScopeAdapter } from "./idp-scope-adapter";

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
          "https://surrealdb.com/db": "ws_beta",
          "https://surrealdb.com/ac": "participant",
        },
      });
    } finally {
      overrideEnv(previousEnv);
      globalThis.fetch = previousFetch;
    }
  });
});
