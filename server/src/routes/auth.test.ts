import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { overrideEnv } from "../env";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("POST /api/auth/token", () => {
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
