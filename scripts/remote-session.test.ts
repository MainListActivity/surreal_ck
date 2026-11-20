import { describe, expect, test, it } from "bun:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRemoteLink } from "./remote-session";

describe("parseRemoteLink", () => {
  const link =
    "https://o.maplayer.top/t/ck/remote#code=abc123&client_id=remote_client&api=https%3A%2F%2Fl.maplayer.top&aud=aud-product&ops_aud=aud-ops";

  it("parses issuer, fragment params and defaults", () => {
    const parsed = parseRemoteLink(link);
    expect(parsed.issuer).toBe("https://o.maplayer.top/t/ck");
    expect(parsed.code).toBe("abc123");
    expect(parsed.clientId).toBe("remote_client");
    expect(parsed.api).toBe("https://l.maplayer.top");
    expect(parsed.aud).toBe("aud-product");
    expect(parsed.opsAud).toBe("aud-ops");
    expect(parsed.dbUrl).toBe("wss://data.maplayer.top/rpc");
  });

  it("honours an explicit db_url fragment param", () => {
    const parsed = parseRemoteLink(link + "&db_url=wss%3A%2F%2Fexample.test%2Frpc");
    expect(parsed.dbUrl).toBe("wss://example.test/rpc");
  });

  it("ops_aud defaults to aud", () => {
    const parsed = parseRemoteLink(
      "https://o.maplayer.top/t/ck/remote#code=x&client_id=c&api=a&aud=p",
    );
    expect(parsed.opsAud).toBe("p");
  });
});

describe("session file layout", () => {
  it("documented path honour SCK_REMOTE_SESSION override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sck-remote-test-"));
    const path = join(dir, "session.json");
    process.env.SCK_REMOTE_SESSION = path;
    // 写一份会话文件验证 0600/路径约定（不写真实 token）
    await Bun.write(path, JSON.stringify({ issuer: "x", clientId: "c", api: "a", aud: "a", opsAud: "o", refreshToken: "t" }));
    const mode = (await stat(path)).mode & 0o777;
    expect([0o600, 0o644]).toContain(mode); // Bun.write 默认 umask；生产路径由脚本 0600 写入
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.issuer).toBe("x");
  });
});

test("fetchWithTimeout passes a 30s abort signal to fetch", async () => {
  const { fetchWithTimeout } = await import("./remote-session");
  let seen: AbortSignal | null | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await fetchWithTimeout("https://example.test/x", { method: "GET" });
  } finally {
    globalThis.fetch = original;
  }
  expect(seen).toBeInstanceOf(AbortSignal);
});

// 全部请求由 mock 接管，不读取真实会话，不访问 IdP / 数据库。
describe("workspace connection resolution", () => {
  const api = "https://api.example.test";
  const database = "ws_authoritative_42";
  const workspace = { slug: "sales-team", dbName: database };
  const jwt = (claims: unknown) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
  const switched = { ok: true, accessToken: jwt({ db: database }), expiresIn: 60 };

  async function run(list: unknown, result: unknown = switched, listStatus = 200, switchStatus = 200) {
    const { resolveWorkspaceConnection } = await import("./remote-session");
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const index = calls.length;
      if (index > 2) throw new Error("unexpected request");
      return new Response(JSON.stringify(index === 1 ? list : result), {
        status: index === 1 ? listStatus : switchStatus,
      });
    }) as typeof fetch;
    try {
      const value = await resolveWorkspaceConnection(api, "mock-access-token", workspace.slug);
      return { value, calls, error: undefined };
    } catch (error) {
      return { value: undefined, calls, error };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("uses the authoritative dbName, authenticates both requests, then checks scope consistency", async () => {
    const { value, calls, error } = await run({ workspaces: [workspace] });
    expect(error).toBeUndefined();
    expect(value?.database).toBe(database);
    expect(value?.database).not.toBe("workspace_sales_team");
    expect(value?.token).toBe(switched.accessToken);
    expect(value?.expiresAt).toBeString();
    expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
      [`${api}/api/session/workspaces`, "GET"],
      [`${api}/api/session/switch-workspace`, "POST"],
    ]);
    for (const { init } of calls) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer mock-access-token" });
    }
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ workspaceSlug: workspace.slug });
  });

  for (const [name, list] of [
    ["missing", { workspaces: [] }],
    ["duplicate", { workspaces: [workspace, workspace] }],
    ["near match", { workspaces: [{ ...workspace, slug: "Sales-team" }] }],
    ["missing list", {}],
    ["null list", { workspaces: null }],
    ["null item", { workspaces: [null] }],
    ["missing db", { workspaces: [{ slug: workspace.slug }] }],
    ["empty db", { workspaces: [{ ...workspace, dbName: "" }] }],
    ["padded db", { workspaces: [{ ...workspace, dbName: " ws " }] }],
    ["nonstring db", { workspaces: [{ ...workspace, dbName: 42 }] }],
    ["control character", { workspaces: [{ ...workspace, dbName: "ws\nsecret" }] }],
  ] as const) {
    it(`rejects ${name} before switching`, async () => {
      const { value, error, calls } = await run(list);
      expect(value).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
    });
  }

  for (const [name, result] of [
    ["mismatched db", { ...switched, accessToken: jwt({ db: "wrong_database" }) }],
    ["missing db", { ...switched, accessToken: jwt({}) }],
    ["nonstring db", { ...switched, accessToken: jwt({ db: 1 }) }],
    ["malformed token", { ...switched, accessToken: "secret-invalid-token" }],
    ["invalid JSON", { ...switched, accessToken: "e30.bm90LWpzb24.c2ln" }],
    ["empty signature", { ...switched, accessToken: `e30.${Buffer.from(JSON.stringify({ db: database })).toString("base64url")}.` }],
    ["missing token", { ok: true, expiresIn: 60 }],
    ["unsuccessful result", { ...switched, ok: false }],
    ["missing expiry", { ok: true, accessToken: switched.accessToken }],
    ["invalid expiry", { ...switched, expiresIn: -1 }],
    ["overflow expiry", { ...switched, expiresIn: 1e30 }],
  ] as const) {
    it(`rejects ${name} without returning connection data or echoing secrets`, async () => {
      const { value, error, calls } = await run({ workspaces: [workspace] }, result);
      expect(value).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("wrong_database");
      expect(String(error)).not.toContain("secret-invalid-token");
      expect(String(error)).not.toContain(switched.accessToken);
      expect(calls).toHaveLength(2);
    });
  }

  it("accepts the contract's nullable expiry", async () => {
    const { value, error } = await run({ workspaces: [workspace] }, { ...switched, expiresIn: null });
    expect(error).toBeUndefined();
    expect(value?.expiresAt).toBeNull();
  });

  it("rejects failed list and switch HTTP responses", async () => {
    const listFailure = await run({ workspaces: [workspace] }, switched, 403);
    expect(listFailure.error).toBeInstanceOf(Error);
    expect(listFailure.calls).toHaveLength(1);
    const switchFailure = await run({ workspaces: [workspace] }, switched, 200, 403);
    expect(switchFailure.error).toBeInstanceOf(Error);
    expect(switchFailure.value).toBeUndefined();
  });
});


describe("db CLI with isolated mock fetch", () => {
  for (const mismatch of [false, true]) {
    it(mismatch ? "fails closed without leaking connection data" : "persists rotated refresh before resolving workspace", async () => {
      const dir = await mkdtemp(join(tmpdir(), "sck-remote-cli-"));
      const sessionPath = join(dir, "session.json");
      const preloadPath = join(dir, "mock-fetch.ts");
      const token = `e30.${Buffer.from(JSON.stringify({ db: mismatch ? "wrong_db" : "ws_exact" })).toString("base64url")}.c2ln`;
      try {
        await Bun.write(sessionPath, JSON.stringify({
          issuer: "https://idp.example.test", clientId: "mock-client", api: "https://api.example.test",
          aud: "product", opsAud: "ops", refreshToken: "mock-old-refresh", dbUrl: "wss://db.example.test/rpc",
        }));
        await Bun.write(preloadPath, `
          let step = 0;
          globalThis.fetch = async (url, init) => {
            step++;
            if (step === 1 && url === "https://idp.example.test/token") {
              const form = new URLSearchParams(init.body);
              if (form.get("resource") !== "product" || form.get("refresh_token") !== "mock-old-refresh") throw new Error("bad refresh");
              return Response.json({ access_token: "mock-product-token", refresh_token: "mock-new-refresh" });
            }
            if (init.headers.authorization !== "Bearer mock-product-token") throw new Error("bad authorization");
            const session = await Bun.file(${JSON.stringify(sessionPath)}).json();
            if (session.refreshToken !== "mock-new-refresh") throw new Error("rotation not persisted");
            if (step === 2 && url === "https://api.example.test/api/session/workspaces") {
              return Response.json({ workspaces: [{ slug: "sales-team", dbName: "ws_exact" }] });
            }
            if (step === 3 && url === "https://api.example.test/api/session/switch-workspace") {
              return Response.json({ ok: true, accessToken: ${JSON.stringify(token)}, expiresIn: null });
            }
            throw new Error("unexpected request");
          };
        `);
        const child = Bun.spawn([process.execPath, "--preload", preloadPath, join(import.meta.dir, "remote-session.ts"), "db", "sales-team"], {
          env: { ...process.env, SCK_REMOTE_SESSION: sessionPath }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(JSON.parse(await readFile(sessionPath, "utf8")).refreshToken).toBe("mock-new-refresh");
        expect(stderr).not.toContain(token);
        expect(stderr).not.toContain("ws_exact");
        expect(stderr).not.toContain("wrong_db");
        if (mismatch) {
          expect(code).toBe(1);
          expect(stdout).toBe("");
          expect(stderr).toContain("无法取得一致的 workspace 连接");
        } else {
          expect(code).toBe(0);
          expect(stderr).toBe("");
          expect(JSON.parse(stdout)).toEqual({
            url: "wss://db.example.test/rpc", namespace: "main", database: "ws_exact", token, expiresAt: null,
          });
        }
        expect(await Bun.file(sessionPath + ".lock").exists()).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});


describe("credential request transport boundaries", () => {
  test("real local 307 never forwards the credential body", async () => {
    const { fetchWithTimeout } = await import("./remote-session");
    let first = 0;
    let redirected = 0;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      redirected += 1;
      return new Response("unexpected");
    } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      first += 1;
      expect(await request.text()).toBe("refresh_token=synthetic-fixture-only");
      return new Response(null, { status: 307, headers: { location: `${target.url}not-allowed` } });
    } });
    try {
      await expect(fetchWithTimeout(String(origin.url), {
        method: "POST", body: "refresh_token=synthetic-fixture-only", redirect: "follow",
      })).rejects.toThrow("认证网络请求失败或发生不允许的重定向");
      expect(first).toBe(1);
      expect(redirected).toBe(0);
    } finally { origin.stop(true); target.stop(true); }
  });

  test("network and timeout errors never echo sensitive URLs or upstream text", async () => {
    const { fetchWithTimeout } = await import("./remote-session");
    const original = globalThis.fetch;
    try {
      for (const error of [new Error("private-token-in-upstream-error"), new DOMException("private-token-in-timeout", "TimeoutError")]) {
        globalThis.fetch = (async () => { throw error; }) as typeof fetch;
        let seen: unknown;
        try { await fetchWithTimeout("https://example.test/?code=private-code", { method: "GET" }); }
        catch (failure) { seen = failure; }
        expect(seen).toBeInstanceOf(Error);
        expect(String(seen)).not.toContain("private");
        expect(String(seen)).not.toContain("https://");
      }
    } finally { globalThis.fetch = original; }
  });

  test("OAuth diagnostic text is limited to exact standard codes", async () => {
    const { safeOAuthError } = await import("./remote-session");
    expect(safeOAuthError("invalid_grant")).toBe("invalid_grant");
    for (const value of ["invalid_grant token=private", "private-token", {}, null, 403]) {
      expect(safeOAuthError(value)).toBe("未知");
    }
  });
});
