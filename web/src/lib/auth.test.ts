import { describe, expect, test } from "bun:test";
import { createAuthClient, createOidcUserManagerSettings } from "./auth";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("OIDC SPA auth client", () => {
  test("OIDC token endpoint points at the backend confidential proxy", () => {
    const settings = createOidcUserManagerSettings({
      env: {
        VITE_API_BASE_URL: "https://api.example.test",
        VITE_OIDC_AUDIENCE: "https://auth.example.test",
        VITE_OIDC_CLIENT_ID: "web-client",
        VITE_OIDC_ISSUER: "https://idp.example.test",
        VITE_OIDC_REDIRECT_URI: "https://app.example.test/auth/callback",
      },
      origin: "https://app.example.test",
      storage: memoryStorage(),
    });

    expect(settings?.metadataSeed).toMatchObject({
      token_endpoint: "https://api.example.test/api/auth/token",
    });
    expect(settings?.client_secret).toBeUndefined();
  });

  test("从 sessionStorage 恢复 access token 和过期时间", () => {
    const auth = createAuthClient({
      storage: memoryStorage({
        "oidc.access_token": "access-token",
        "oidc.id_token": "legacy-id-token",
        "oidc.exp": "1893456000",
        "oidc.claims": JSON.stringify({ email: "legacy@example.test" }),
      }),
      now: () => new Date("2026-05-28T00:00:00Z"),
    });

    expect(auth.getToken()).toBe("access-token");
    expect(auth.getSession()).toEqual({ accessToken: "access-token", expiresAt: 1893456000 });
    expect(auth.isAuthenticated()).toBe(true);
  });

  test("storeAccessToken 持久化后端 scope exchange 返回的新 access token", () => {
    const storage = memoryStorage({
      "oidc.access_token": "old-access-token",
      "oidc.exp": "1893456000",
      "oidc.id_token": "legacy-id-token",
      "oidc.claims": JSON.stringify({ email: "legacy@example.test" }),
    });
    const auth = createAuthClient({
      storage,
      now: () => new Date("2026-05-28T00:00:00Z"),
    });

    const token = unsignedJwt({
      exp: Date.parse("2026-05-28T01:00:00Z") / 1000,
      db: "ws_beta",
    });

    expect(auth.storeAccessToken(token, null)).toBe(token);
    expect(storage.getItem("oidc.access_token")).toBe(token);
    expect(storage.getItem("oidc.exp")).toBe(String(Date.parse("2026-05-28T01:00:00Z") / 1000));
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
  });

  test("callback 成功后只持久化 access token 和过期时间", async () => {
    const storage = memoryStorage();
    const auth = createAuthClient({
      storage,
      userManager: {
        async signinRedirectCallback(url: string) {
          expect(url).toBe("https://app.example.test/auth/callback?code=abc&state=xyz");
          return {
            access_token: "new-access-token",
            id_token: "new-id-token",
            expires_at: 1893456000,
            profile: { sub: "user:ada" },
            state: { returnTo: "/workbooks" },
          };
        },
      },
    });

    const result = await auth.handleCallback(
      "https://app.example.test/auth/callback?code=abc&state=xyz",
    );

    expect(result).toEqual({ ok: true, returnTo: "/workbooks" });
    expect(storage.getItem("oidc.access_token")).toBe("new-access-token");
    expect(storage.getItem("oidc.exp")).toBe("1893456000");
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
  });

  test("callback 不要求 email、SurrealDB db 或 SurrealDB access claim", async () => {
    const storage = memoryStorage();
    const auth = createAuthClient({
      storage,
      now: () => new Date("2026-05-28T00:00:00Z"),
      userManager: {
        async signinRedirectCallback() {
          return {
            access_token: "opaque-access-token",
            expires_in: 3600,
            profile: { sub: "user:ada" },
            state: { returnTo: "/workbooks" },
          };
        },
      },
    });

    const result = await auth.handleCallback(
      "https://app.example.test/auth/callback?code=abc&state=xyz",
    );

    expect(result).toEqual({ ok: true, returnTo: "/workbooks" });
    expect(storage.getItem("oidc.access_token")).toBe("opaque-access-token");
    expect(storage.getItem("oidc.exp")).toBe(String(Date.parse("2026-05-28T01:00:00Z") / 1000));
  });

  test("callback 不从 id_token 补全或持久化浏览器 session", async () => {
    const storage = memoryStorage();
    const auth = createAuthClient({
      storage,
      userManager: {
        async signinRedirectCallback() {
          return {
            access_token: "opaque-access-token",
            id_token: unsignedJwt({
              email: "ada@example.test",
              db: "ws_wrong",
              ac: "admin",
            }),
            expires_at: 1893456000,
            profile: {},
            state: { returnTo: "/workbooks" },
          };
        },
      },
    });

    const result = await auth.handleCallback(
      "https://app.example.test/auth/callback?code=abc&state=xyz",
    );

    expect(result).toEqual({ ok: true, returnTo: "/workbooks" });
    expect(storage.getItem("oidc.access_token")).toBe("opaque-access-token");
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
  });

  test("callback 缺少 code 或 state 时返回明确错误且不换 token", async () => {
    let exchangeCalled = false;
    const auth = createAuthClient({
      storage: memoryStorage(),
      userManager: {
        async signinRedirectCallback() {
          exchangeCalled = true;
          throw new Error("should not exchange token");
        },
      },
    });

    const result = await auth.handleCallback("https://app.example.test/auth/callback?code=abc");

    expect(result).toEqual({ ok: false, error: "OIDC callback is missing code or state" });
    expect(exchangeCalled).toBe(false);
  });

  test("callback session 缺少 access token 时返回具体缺失项", async () => {
    const auth = createAuthClient({
      storage: memoryStorage(),
      userManager: {
        async signinRedirectCallback() {
          return {
            expires_at: 1893456000,
            profile: { sub: "user:ada" },
            state: { returnTo: "/workbooks" },
          };
        },
      },
    });

    const result = await auth.handleCallback(
      "https://app.example.test/auth/callback?code=abc&state=xyz",
    );

    expect(result).toEqual({
      ok: false,
      error: "OIDC callback did not return a complete session: missing access_token",
    });
  });

  test("callback session 缺少过期时间时返回具体缺失项", async () => {
    const auth = createAuthClient({
      storage: memoryStorage(),
      userManager: {
        async signinRedirectCallback() {
          return {
            access_token: "access-token",
            profile: { sub: "user:ada" },
            state: { returnTo: "/workbooks" },
          };
        },
      },
    });

    const result = await auth.handleCallback(
      "https://app.example.test/auth/callback?code=abc&state=xyz",
    );

    expect(result).toEqual({
      ok: false,
      error: "OIDC callback did not return a complete session: missing expires_at/expires_in",
    });
  });

  test("token 距过期不足 5 分钟时 silent refresh 并原地更新 session", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "old-access-token",
      "oidc.exp": String(Date.parse("2026-05-28T00:04:00Z") / 1000),
    });
    let silentCalled = false;
    const auth = createAuthClient({
      storage,
      now: () => new Date("2026-05-28T00:00:00Z"),
      userManager: {
        async signinSilent() {
          silentCalled = true;
          return {
            access_token: "refreshed-access-token",
            id_token: "refreshed-id-token",
            expires_at: 1893459600,
            profile: {},
          };
        },
      },
    });

    await expect(auth.refresh()).resolves.toBe("refreshed-access-token");

    expect(silentCalled).toBe(true);
    expect(storage.getItem("oidc.access_token")).toBe("refreshed-access-token");
    expect(storage.getItem("oidc.exp")).toBe("1893459600");
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
  });

  test("silent refresh 失败时清空 session 并跳到 login", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "stale-access-token",
      "oidc.id_token": "stale-id-token",
      "oidc.exp": String(Date.parse("2026-05-28T00:04:00Z") / 1000),
      "oidc.claims": JSON.stringify({ email: "legacy@example.test" }),
    });
    const navigations: string[] = [];
    const auth = createAuthClient({
      storage,
      now: () => new Date("2026-05-28T00:00:00Z"),
      currentPath: () => "/workbooks/alpha?tab=grid",
      navigate: (url) => navigations.push(url),
      userManager: {
        async signinSilent() {
          throw new Error("login_required");
        },
      },
    });

    await expect(auth.refresh()).resolves.toBeNull();

    expect(storage.getItem("oidc.access_token")).toBeNull();
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.exp")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
    expect(navigations).toEqual(["/auth/login?returnTo=%2Fworkbooks%2Falpha%3Ftab%3Dgrid"]);
  });

  test("silent refresh 返回空用户时也清空 session 并跳到 login", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "stale-access-token",
      "oidc.id_token": "stale-id-token",
      "oidc.exp": String(Date.parse("2026-05-28T00:04:00Z") / 1000),
      "oidc.claims": JSON.stringify({ email: "legacy@example.test" }),
    });
    const navigations: string[] = [];
    const auth = createAuthClient({
      storage,
      now: () => new Date("2026-05-28T00:00:00Z"),
      currentPath: () => "/workbooks/alpha",
      navigate: (url) => navigations.push(url),
      userManager: {
        async signinSilent() {
          return null;
        },
      },
    });

    await expect(auth.refresh()).resolves.toBeNull();

    expect(storage.getItem("oidc.access_token")).toBeNull();
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
    expect(navigations).toEqual(["/auth/login?returnTo=%2Fworkbooks%2Falpha"]);
  });

  test("logout 清空 sessionStorage 并跳 IdP logout", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "access-token",
      "oidc.id_token": "legacy-id-token",
      "oidc.exp": "1893456000",
      "oidc.claims": JSON.stringify({ email: "legacy@example.test" }),
    });
    let signoutCalled = false;
    const auth = createAuthClient({
      storage,
      userManager: {
        async signoutRedirect() {
          signoutCalled = true;
        },
      },
    });

    await auth.logout();

    expect(storage.getItem("oidc.access_token")).toBeNull();
    expect(storage.getItem("oidc.id_token")).toBeNull();
    expect(storage.getItem("oidc.exp")).toBeNull();
    expect(storage.getItem("oidc.claims")).toBeNull();
    expect(signoutCalled).toBe(true);
  });

  test("未登录访问业务路由时跳到 login 并保留 returnTo", () => {
    const navigations: string[] = [];
    const auth = createAuthClient({
      storage: memoryStorage(),
      currentPath: () => "/workbooks/alpha?tab=grid",
      navigate: (url) => navigations.push(url),
    });

    expect(auth.requireAuthenticatedRoute()).toBe(false);

    expect(navigations).toEqual(["/auth/login?returnTo=%2Fworkbooks%2Falpha%3Ftab%3Dgrid"]);
  });

  test("login 通过 OIDC client 发起 redirect 并携带 returnTo state", async () => {
    let redirectArgs: unknown;
    const auth = createAuthClient({
      storage: memoryStorage(),
      currentPath: () => "/workbooks/alpha",
      userManager: {
        async signinRedirect(args: unknown) {
          redirectArgs = args;
        },
      },
    });

    await auth.login();

    expect(redirectArgs).toEqual({ state: { returnTo: "/workbooks/alpha" } });
  });
});
