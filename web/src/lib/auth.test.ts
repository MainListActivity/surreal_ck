import { describe, expect, test } from "bun:test";
import { createAuthClient, type AuthClaims } from "./auth";

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

const claims: AuthClaims = {
  sub: "user:ada",
  email: "ada@example.test",
  name: "Ada",
  "https://surrealdb.com/db": "ws_a1b2c3d4e5f6",
  "https://surrealdb.com/ac": "admin",
};

describe("OIDC SPA auth client", () => {
  test("从 sessionStorage 恢复 token 和 SurrealDB scope claims", () => {
    const auth = createAuthClient({
      storage: memoryStorage({
        "oidc.access_token": "access-token",
        "oidc.id_token": "id-token",
        "oidc.exp": "1893456000",
        "oidc.claims": JSON.stringify(claims),
      }),
      now: () => new Date("2026-05-28T00:00:00Z"),
    });

    expect(auth.getToken()).toBe("access-token");
    expect(auth.getClaims()).toEqual(claims);
    expect(auth.isAuthenticated()).toBe(true);
  });

  test("callback 成功后持久化 token、过期时间和 claims", async () => {
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
            profile: claims,
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
    expect(storage.getItem("oidc.id_token")).toBe("new-id-token");
    expect(storage.getItem("oidc.exp")).toBe("1893456000");
    expect(JSON.parse(storage.getItem("oidc.claims") ?? "{}")).toEqual(claims);
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

  test("token 距过期不足 5 分钟时 silent refresh 并原地更新 session", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "old-access-token",
      "oidc.exp": String(Date.parse("2026-05-28T00:04:00Z") / 1000),
      "oidc.claims": JSON.stringify(claims),
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
            profile: { ...claims, "https://surrealdb.com/ac": "participant" },
          };
        },
      },
    });

    await expect(auth.refresh()).resolves.toBe("refreshed-access-token");

    expect(silentCalled).toBe(true);
    expect(storage.getItem("oidc.access_token")).toBe("refreshed-access-token");
    expect(storage.getItem("oidc.id_token")).toBe("refreshed-id-token");
    expect(JSON.parse(storage.getItem("oidc.claims") ?? "{}")).toEqual({
      ...claims,
      "https://surrealdb.com/ac": "participant",
    });
  });

  test("silent refresh 失败时清空 session 并跳到 login", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "stale-access-token",
      "oidc.id_token": "stale-id-token",
      "oidc.exp": String(Date.parse("2026-05-28T00:04:00Z") / 1000),
      "oidc.claims": JSON.stringify(claims),
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
      "oidc.claims": JSON.stringify(claims),
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
    expect(navigations).toEqual(["/auth/login?returnTo=%2Fworkbooks%2Falpha"]);
  });

  test("logout 清空 sessionStorage 并跳 IdP logout", async () => {
    const storage = memoryStorage({
      "oidc.access_token": "access-token",
      "oidc.id_token": "id-token",
      "oidc.exp": "1893456000",
      "oidc.claims": JSON.stringify(claims),
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
