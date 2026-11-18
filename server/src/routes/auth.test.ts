import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { overrideEnv } from "../env";
import { createOidcOpsBrowserProxyFromEnv, createOidcTokenExchangeFromEnv } from "./auth";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("POST /api/auth/token", () => {
  test("proxies operations PKCE token exchange and JWKS without exposing a client secret", async () => {
    const upstream: Array<{ url: string; method: string; body: string }> = [];
    const app = createApp({
      oidcOpsBrowserProxy: {
        clientId: "ops-public-client",
        tokenEndpoint: "https://idp.example.test/token",
        jwksUrl: "https://idp.example.test/jwks.json",
        fetch: async (input, init = {}) => {
          upstream.push({ url: String(input), method: init.method ?? "GET", body: String(init.body ?? "") });
          if (String(input).endsWith("jwks.json")) return Response.json({ keys: [{ kid: "k1" }] });
          return Response.json({ access_token: "ops-token", refresh_token: "must-not-leak", token_type: "Bearer" });
        },
      },
    });

    const token = await app.request("/api/auth/ops/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "ops-code",
        code_verifier: "ops-verifier",
        client_id: "forged-client",
        client_secret: "forged-secret",
        redirect_uri: "https://ops.example.test/auth/callback.html",
      }),
    });
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual({ access_token: "ops-token", token_type: "Bearer" });
    expect(upstream[0]?.body).toContain("client_id=ops-public-client");
    expect(upstream[0]?.body).not.toContain("forged-secret");

    const jwks = await app.request("/api/auth/ops/jwks");
    expect(jwks.status).toBe(200);
    expect(await jwks.json()).toEqual({ keys: [{ kid: "k1" }] });
    expect(jwks.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("revokes operations tokens upstream with pinned client id and no client secret", async () => {
    const upstream: Array<{ url: string; body: string }> = [];
    const app = createApp({
      oidcOpsBrowserProxy: {
        clientId: "ops-public-client",
        tokenEndpoint: "https://idp.example.test/token",
        jwksUrl: "https://idp.example.test/jwks.json",
        revokeEndpoint: "https://idp.example.test/revoke",
        fetch: async (input, init = {}) => {
          upstream.push({ url: String(input), body: String(init?.body ?? "") });
          return new Response(null, { status: 200 });
        },
      },
    });

    const revoked = await app.request("/api/auth/ops/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "ops-access-token",
        token_type_hint: "access_token",
        client_id: "forged-client",
        client_secret: "forged-secret",
      }),
    });
    expect(revoked.status).toBe(200);
    expect(upstream[0]?.url).toBe("https://idp.example.test/revoke");
    expect(upstream[0]?.body).toContain("token=ops-access-token");
    expect(upstream[0]?.body).toContain("client_id=ops-public-client");
    expect(upstream[0]?.body).not.toContain("forged-secret");
  });

  test("revoke requires a token and rejects empty bodies", async () => {
    const app = createApp({
      oidcOpsBrowserProxy: {
        clientId: "ops-public-client",
        tokenEndpoint: "https://idp.example.test/token",
        jwksUrl: "https://idp.example.test/jwks.json",
        revokeEndpoint: "https://idp.example.test/revoke",
      },
    });
    const response = await app.request("/api/auth/ops/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(response.status).toBe(400);
  });

  test("revoke fails closed when the ops client id is not pinned", async () => {
    const app = createApp({
      oidcOpsBrowserProxy: {
        tokenEndpoint: "https://idp.example.test/token",
        jwksUrl: "https://idp.example.test/jwks.json",
        revokeEndpoint: "https://idp.example.test/revoke",
      },
    });
    const response = await app.request("/api/auth/ops/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "t", client_id: "forged-client" }).toString(),
    });
    expect(response.status).toBe(501);
  });

  test("exchanges an authorization code through the backend confidential client using client_secret_basic", async () => {
    let upstreamRequest: { url: string; method: string; body: string; authorization: string | null } | undefined;
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        fetch: async (input, init = {}) => {
          upstreamRequest = {
            url: String(input),
            method: init.method ?? "GET",
            body: String(init.body),
            authorization: new Headers(init.headers).get("authorization"),
          };
          return Response.json({
            access_token: "access-token-from-idp",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "web-client",
        code_verifier: "pkce-verifier",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "access-token-from-idp",
      token_type: "Bearer",
      expires_in: 3600,
    });
    expect(upstreamRequest).toEqual({
      url: "https://idp.example.test/token",
      method: "POST",
      body: "grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%2Fcallback&code_verifier=pkce-verifier",
      authorization: `Basic ${btoa("web-client:server-secret")}`,
    });
  });

  test("supports client_secret_post when explicitly configured", async () => {
    let upstreamRequest: { body: string; authorization: string | null } | undefined;
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        tokenAuthMethod: "client_secret_post",
        fetch: async (_input, init = {}) => {
          upstreamRequest = {
            body: String(init.body),
            authorization: new Headers(init.headers).get("authorization"),
          };
          return Response.json({
            access_token: "access-token-from-idp",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "browser-supplied-client",
        code_verifier: "pkce-verifier",
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRequest).toEqual({
      body: "grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%2Fcallback&code_verifier=pkce-verifier&client_id=web-client&client_secret=server-secret",
      authorization: null,
    });
  });

  test("does not expose refresh tokens returned by the IdP", async () => {
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        fetch: async () => Response.json({
          access_token: "access-token-from-idp",
          refresh_token: "refresh-token-must-stay-server-side",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "web-client",
        code_verifier: "pkce-verifier",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "access-token-from-idp",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  test("rejects token exchange requests without an authorization code", async () => {
    let upstreamCalled = false;
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        fetch: async () => {
          upstreamCalled = true;
          return Response.json({ access_token: "should-not-happen" });
        },
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "web-client",
        code_verifier: "pkce-verifier",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "oidc-token-code-required" },
    });
    expect(upstreamCalled).toBe(false);
  });

  test("normalizes IdP token endpoint failures without exposing sensitive upstream details", async () => {
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        fetch: async () => Response.json({
          error: "invalid_grant",
          error_description: "bad code auth-code with server-secret and access-token",
        }, { status: 400 }),
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "web-client",
        code_verifier: "pkce-verifier",
      }),
    });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("oidc-token-exchange-failed");
    expect(text).not.toContain("auth-code");
    expect(text).not.toContain("server-secret");
    expect(text).not.toContain("access-token");
  });

  test("uses server OIDC confidential client environment when no test exchange is injected", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamRequest: { url: string; body: string; authorization: string | null } | undefined;
    globalThis.fetch = (async (input, init = {}) => {
      upstreamRequest = {
        url: String(input),
        body: String(init.body),
        authorization: new Headers(init.headers).get("authorization"),
      };
      return Response.json({
        access_token: "access-token-from-env-config",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as typeof fetch;
    overrideEnv({
      OIDC_CLIENT_ID: "web-client",
      OIDC_CLIENT_SECRET: "server-secret",
      OIDC_TOKEN_ENDPOINT: "https://idp.example.test/token",
    });

    try {
      const app = createApp();
      const response = await app.request("/api/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "auth-code",
          redirect_uri: "https://app.example.test/auth/callback",
          client_id: "web-client",
          code_verifier: "pkce-verifier",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ access_token: "access-token-from-env-config" });
      expect(upstreamRequest).toEqual({
        url: "https://idp.example.test/token",
        body: "grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%2Fcallback&code_verifier=pkce-verifier",
        authorization: `Basic ${btoa("web-client:server-secret")}`,
      });
    } finally {
      globalThis.fetch = originalFetch;
      overrideEnv({
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
        OIDC_TOKEN_ENDPOINT: undefined,
      });
    }
  });

  test("does not log thrown upstream error details that may contain token exchange secrets", async () => {
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    };
    const app = createApp({
      oidcTokenExchange: {
        clientId: "web-client",
        clientSecret: "server-secret",
        tokenEndpoint: "https://idp.example.test/token",
        fetch: async () => {
          throw new Error("socket failed for auth-code with server-secret and access-token");
        },
      },
    });

    const response = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://app.example.test/auth/callback",
        client_id: "web-client",
        code_verifier: "pkce-verifier",
      }),
    });

    const responseText = await response.text();
    const logText = logs.join("\n");
    expect(response.status).toBe(502);
    expect(responseText).toContain("oidc-token-exchange-failed");
    expect(`${responseText}\n${logText}`).not.toContain("auth-code");
    expect(`${responseText}\n${logText}`).not.toContain("server-secret");
    expect(`${responseText}\n${logText}`).not.toContain("access-token");
  });
});

describe("OIDC upstream timeout and failure classification", () => {
  type UpstreamRoute = {
    name: string;
    code: string;
    /** revoke 成功响应本就是空体，不参与 invalid_json 分类。 */
    parsesJsonBody: boolean;
    /** token 路由把 2xx 的 JSON null 归为 invalid_json；jwks/revoke 不适用。 */
    nullBodyIsInvalidJson?: boolean;
    makeApp: (fetchImpl: typeof fetch) => ReturnType<typeof createApp>;
    hit: (app: ReturnType<typeof createApp>) => Promise<Response>;
  };

  const sensitiveMarkers = [
    "auth-code",
    "pkce-verifier",
    "ops-code",
    "ops-verifier",
    "ops-access-token",
    "access-token-from-idp",
    "server-secret",
    "forged-secret",
    "refresh-token-must-stay-server-side",
    "upstream-secret-body",
  ];

  const expectNoSensitiveLeak = (text: string) => {
    for (const marker of sensitiveMarkers) {
      expect(text).not.toContain(marker);
    }
  };

  const upstreamRoutes: UpstreamRoute[] = [
    {
      name: "POST /api/auth/token",
      code: "oidc-token-exchange-failed",
      parsesJsonBody: true,
      nullBodyIsInvalidJson: true,
      makeApp: (fetchImpl) => createApp({
        oidcTokenExchange: {
          clientId: "web-client",
          clientSecret: "server-secret",
          tokenEndpoint: "https://idp.example.test/token",
          upstreamTimeoutMs: 10,
          fetch: fetchImpl,
        },
      }),
      hit: (app) => app.request("/api/auth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "auth-code",
          code_verifier: "pkce-verifier",
          redirect_uri: "https://app.example.test/auth/callback",
        }),
      }),
    },
    {
      name: "GET /api/auth/ops/jwks",
      code: "oidc-ops-jwks-failed",
      parsesJsonBody: true,
      makeApp: (fetchImpl) => createApp({
        oidcOpsBrowserProxy: {
          clientId: "ops-public-client",
          tokenEndpoint: "https://idp.example.test/token",
          jwksUrl: "https://idp.example.test/jwks.json",
          upstreamTimeoutMs: 10,
          fetch: fetchImpl,
        },
      }),
      hit: (app) => app.request("/api/auth/ops/jwks"),
    },
    {
      name: "POST /api/auth/ops/token",
      code: "oidc-ops-token-exchange-failed",
      parsesJsonBody: true,
      nullBodyIsInvalidJson: true,
      makeApp: (fetchImpl) => createApp({
        oidcOpsBrowserProxy: {
          clientId: "ops-public-client",
          tokenEndpoint: "https://idp.example.test/token",
          jwksUrl: "https://idp.example.test/jwks.json",
          upstreamTimeoutMs: 10,
          fetch: fetchImpl,
        },
      }),
      hit: (app) => app.request("/api/auth/ops/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "ops-code",
          code_verifier: "ops-verifier",
          client_secret: "forged-secret",
          redirect_uri: "https://ops.example.test/auth/callback.html",
        }),
      }),
    },
    {
      name: "POST /api/auth/ops/revoke",
      code: "oidc-ops-revoke-failed",
      parsesJsonBody: false,
      makeApp: (fetchImpl) => createApp({
        oidcOpsBrowserProxy: {
          clientId: "ops-public-client",
          tokenEndpoint: "https://idp.example.test/token",
          jwksUrl: "https://idp.example.test/jwks.json",
          revokeEndpoint: "https://idp.example.test/revoke",
          upstreamTimeoutMs: 10,
          fetch: fetchImpl,
        },
      }),
      hit: (app) => app.request("/api/auth/ops/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "ops-access-token",
          client_secret: "forged-secret",
        }),
      }),
    },
  ];

  for (const route of upstreamRoutes) {
    test(`${route.name} returns 502 timeout when the upstream call exceeds upstreamTimeoutMs`, async () => {
      let calls = 0;
      let sawAbortSignal = false;
      const app = route.makeApp(async (_input, init = {}) => {
        calls += 1;
        const signal = init.signal;
        sawAbortSignal = signal instanceof AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const response = await route.hit(app);

      expect(response.status).toBe(502);
      expect(sawAbortSignal).toBe(true);
      const body = await response.json();
      expect(body).toMatchObject({
        error: { code: route.code, details: { reason: "timeout" } },
      });
      // 一次性 authorization code / token：超时后严禁自动重试，上游只被调一次。
      expect(calls).toBe(1);
      expectNoSensitiveLeak(JSON.stringify(body));
    });

    test(`${route.name} returns 502 network on upstream transport errors without leaking secrets`, async () => {
      const logs: string[] = [];
      console.error = (...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      };
      let calls = 0;
      const app = route.makeApp(async () => {
        calls += 1;
        throw new Error("socket failed carrying auth-code ops-verifier ops-access-token server-secret forged-secret");
      });

      const response = await route.hit(app);

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({
        error: { code: route.code, details: { reason: "network" } },
      });
      expect(calls).toBe(1);
      expectNoSensitiveLeak(`${JSON.stringify(body)}\n${logs.join("\n")}`);
    });

    test(`${route.name} returns 502 upstream_status with upstreamStatus on non-2xx and never echoes the upstream body`, async () => {
      const app = route.makeApp(async () =>
        Response.json(
          { error: "invalid_grant", error_description: "upstream-secret-body auth-code server-secret" },
          { status: 400 },
        ));

      const response = await route.hit(app);

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({
        error: { code: route.code, details: { reason: "upstream_status", upstreamStatus: 400 } },
      });
      expectNoSensitiveLeak(JSON.stringify(body));
    });

    if (route.parsesJsonBody) {
      test(`${route.name} returns 502 invalid_json when the upstream 2xx body is not JSON`, async () => {
        const app = route.makeApp(async () => new Response("<upstream-secret-body>not json", { status: 200 }));

        const response = await route.hit(app);

        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
          error: { code: route.code, details: { reason: "invalid_json" } },
        });
        expectNoSensitiveLeak(JSON.stringify(body));
      });

      test(`${route.name} returns 502 timeout when the upstream body stalls mid-read`, async () => {
        const app = route.makeApp(async (_input, init = {}) => {
          const signal = init.signal;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"keys":'));
              signal?.addEventListener("abort", () => controller.error(signal.reason));
            },
          });
          return new Response(stream, { status: 200 });
        });

        const response = await route.hit(app);

        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
          error: { code: route.code, details: { reason: "timeout" } },
        });
        expectNoSensitiveLeak(JSON.stringify(body));
      });
    }

    if (route.nullBodyIsInvalidJson) {
      test(`${route.name} returns 502 invalid_json when the upstream 2xx body is JSON null`, async () => {
        const app = route.makeApp(async () => new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }));

        const response = await route.hit(app);

        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
          error: { code: route.code, details: { reason: "invalid_json" } },
        });
        expectNoSensitiveLeak(JSON.stringify(body));
      });
    }
  }

  test("reads OIDC_UPSTREAM_TIMEOUT_MS from the environment for both proxies", () => {
    overrideEnv({
      OIDC_UPSTREAM_TIMEOUT_MS: 4321,
      OIDC_CLIENT_ID: "web-client",
      OIDC_CLIENT_SECRET: "server-secret",
      OIDC_TOKEN_ENDPOINT: "https://idp.example.test/token",
      OIDC_JWKS_URL: "https://idp.example.test/jwks.json",
    });

    try {
      expect(createOidcTokenExchangeFromEnv()?.upstreamTimeoutMs).toBe(4321);
      expect(createOidcOpsBrowserProxyFromEnv()?.upstreamTimeoutMs).toBe(4321);
    } finally {
      overrideEnv({
        OIDC_UPSTREAM_TIMEOUT_MS: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
        OIDC_TOKEN_ENDPOINT: undefined,
        OIDC_JWKS_URL: undefined,
      });
    }
  });
});
