import { describe, expect, test } from "bun:test";
import { HttpIdpAdminClient } from "./idp-admin-client";

type Req = { url: string; method: string; body?: unknown; auth?: string | null };

function fakeFetch(handlers: Record<string, (req: Req) => { status: number; body: unknown }>) {
  const log: Req[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const req: Req = {
      url: u.pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    log.push(req);
    const key = `${req.method} ${req.url}`;
    const handler = handlers[key];
    if (!handler) return new Response(JSON.stringify({ error: "unmocked" }), { status: 500 });
    const { status, body } = handler(req);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl: impl as typeof fetch, log };
}

const CONFIG = { baseUrl: "https://o.maplayer.top", email: "admin@x", password: "pw", tenantSlug: "ck" };

function baseHandlers(overrides: Record<string, (req: Req) => { status: number; body: unknown }> = {}) {
  return {
    "POST /admin/login": () => ({ status: 200, body: { session_token: "sess-1" } }),
    "GET /admin/tenants": () => ({ status: 200, body: { tenants: [{ id: "t-1", slug: "ck" }] } }),
    "POST /admin/tenants/t-1/users": () => ({
      status: 201,
      body: {
        user: { id: "u-1", email: "lawyer@example.com", display_name: "陈律师", status: "provisioned" },
        activation_url: "https://o.maplayer.top/activate-account?token=ONE_TIME",
      },
    }),
    "GET /admin/tenants/t-1/users": () => ({ status: 200, body: { users: [] } }),
    ...overrides,
  };
}

describe("G2 HttpIdpAdminClient", () => {
  test("新建用户：login→tenants→POST users，回 activation_url", async () => {
    const { impl, log } = fakeFetch(baseHandlers());
    const client = new HttpIdpAdminClient(CONFIG, impl);
    const result = await client.ensureUser({ email: "lawyer@example.com", displayName: "陈律师" });
    expect(result.created).toBe(true);
    expect(result.user.id).toBe("u-1");
    expect(result.activationUrl).toContain("activate-account?token=");
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /admin/login", "GET /admin/tenants", "POST /admin/tenants/t-1/users",
    ]);
    // admin 会话经 Bearer 携带；登录体含邮箱+密码，不出现在后续请求体里。
    expect(log[0].body).toEqual({ email: "admin@x", password: "pw" });
    expect(log[2].auth).toBe("Bearer sess-1");
  });

  test("409 → 列表按邮箱幂等复用，不重发激活链接", async () => {
    const { impl } = fakeFetch(baseHandlers({
      "POST /admin/tenants/t-1/users": () => ({ status: 409, body: { error: "conflict" } }),
      "GET /admin/tenants/t-1/users": () => ({
        status: 200,
        body: { users: [
          { id: "u-other", email: "other@example.com", display_name: "别人", status: "active" },
          { id: "u-9", email: "Lawyer@Example.com ", display_name: "陈律师", status: "active" },
        ] },
      }),
    }));
    const client = new HttpIdpAdminClient(CONFIG, impl);
    const result = await client.ensureUser({ email: "lawyer@example.com", displayName: "陈律师" });
    expect(result.created).toBe(false);
    expect(result.user.id).toBe("u-9");
    expect(result.activationUrl).toBeNull();
  });

  test("admin 登录失败 → idp-admin-login-failed", async () => {
    const { impl } = fakeFetch({
      "POST /admin/login": () => ({ status: 401, body: { error: "invalid_credentials" } }),
    });
    const client = new HttpIdpAdminClient(CONFIG, impl);
    await expect(client.ensureUser({ email: "a@b.c", displayName: "x" }))
      .rejects.toMatchObject({ code: "idp-admin-login-failed" });
  });

  test("租户不存在 → idp-admin-tenant-missing", async () => {
    const { impl } = fakeFetch(baseHandlers({
      "GET /admin/tenants": () => ({ status: 200, body: { tenants: [{ id: "t-1", slug: "other" }] } }),
    }));
    const client = new HttpIdpAdminClient(CONFIG, impl);
    await expect(client.ensureUser({ email: "a@b.c", displayName: "x" }))
      .rejects.toMatchObject({ code: "idp-admin-tenant-missing" });
  });

  test("409 但查无此人 → idp-admin-user-conflict-unresolved", async () => {
    const { impl } = fakeFetch(baseHandlers({
      "POST /admin/tenants/t-1/users": () => ({ status: 409, body: { error: "conflict" } }),
      "GET /admin/tenants/t-1/users": () => ({ status: 200, body: { users: [] } }),
    }));
    const client = new HttpIdpAdminClient(CONFIG, impl);
    await expect(client.ensureUser({ email: "a@b.c", displayName: "x" }))
      .rejects.toMatchObject({ code: "idp-admin-user-conflict-unresolved" });
  });

  test("401 后清会话重登重试一次", async () => {
    let logins = 0;
    let attempts = 0;
    const { impl } = fakeFetch({
      "POST /admin/login": () => { logins += 1; return { status: 200, body: { session_token: `sess-${logins}` } }; },
      "GET /admin/tenants": () => ({ status: 200, body: { tenants: [{ id: "t-1", slug: "ck" }] } }),
      "POST /admin/tenants/t-1/users": (req) => {
        attempts += 1;
        if (attempts === 1) return { status: 401, body: { error: "unauthorized" } };
        expect(req.auth).toBe("Bearer sess-2");
        return { status: 201, body: { user: { id: "u-2", email: "a@b.c", display_name: "x", status: "provisioned" }, activation_url: null } };
      },
    });
    const client = new HttpIdpAdminClient(CONFIG, impl);
    const result = await client.ensureUser({ email: "a@b.c", displayName: "x" });
    expect(result.user.id).toBe("u-2");
    expect(logins).toBe(2);
  });
});
