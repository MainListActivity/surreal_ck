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

const CONFIG = {
  baseUrl: "https://o.maplayer.top",
  provisionToken: "provision-token-fixture",
  tenantSlug: "ck",
};

function baseHandlers(overrides: Record<string, (req: Req) => { status: number; body: unknown }> = {}) {
  return {
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

describe("G2 HttpIdpAdminClient (provision token)", () => {
  test("新建用户：tenants→POST users，Bearer 为 provision token，不请求 /admin/login", async () => {
    const { impl, log } = fakeFetch(baseHandlers());
    const client = new HttpIdpAdminClient(CONFIG, impl);
    const result = await client.ensureUser({ email: "lawyer@example.com", displayName: "陈律师" });
    expect(result.created).toBe(true);
    expect(result.user.id).toBe("u-1");
    expect(result.activationUrl).toContain("activate-account?token=");
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /admin/tenants",
      "POST /admin/tenants/t-1/users",
    ]);
    expect(log.every((r) => r.url !== "/admin/login")).toBe(true);
    expect(log.every((r) => r.auth === "Bearer provision-token-fixture")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("admin@");
    expect(JSON.stringify(log)).not.toContain("password");
  });

  test("409 → 列表按邮箱幂等复用，不重发激活链接", async () => {
    const { impl, log } = fakeFetch(baseHandlers({
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
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /admin/tenants",
      "POST /admin/tenants/t-1/users",
      "GET /admin/tenants/t-1/users",
    ]);
    expect(log.every((r) => r.auth === "Bearer provision-token-fixture")).toBe(true);
  });

  test("租户不存在 → idp-admin-tenant-missing", async () => {
    const { impl, log } = fakeFetch(baseHandlers({
      "GET /admin/tenants": () => ({ status: 200, body: { tenants: [{ id: "t-1", slug: "other" }] } }),
    }));
    const client = new HttpIdpAdminClient(CONFIG, impl);
    await expect(client.ensureUser({ email: "a@b.c", displayName: "x" }))
      .rejects.toMatchObject({ code: "idp-admin-tenant-missing" });
    expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /admin/tenants"]);
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

  test("401/403 不重试 login，直接 provision-failed", async () => {
    const { impl, log } = fakeFetch(baseHandlers({
      "POST /admin/tenants/t-1/users": () => ({ status: 403, body: { error: "forbidden" } }),
    }));
    const client = new HttpIdpAdminClient(CONFIG, impl);
    await expect(client.ensureUser({ email: "a@b.c", displayName: "x" }))
      .rejects.toMatchObject({ code: "idp-admin-provision-failed", status: 403 });
    expect(log.some((r) => r.url === "/admin/login")).toBe(false);
    expect(log.filter((r) => r.method === "POST" && r.url.endsWith("/users"))).toHaveLength(1);
  });
});
