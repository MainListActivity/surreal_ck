import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createOpsProvisionTokenRoutes } from "./ops-provision-token";
import type { ResolvedProvisionToken } from "../invitations/idp-admin-client";

const VALID_TOKEN = "tok_" + "a".repeat(40);

function makeApp(overrides: {
  capabilities?: string[];
  tokenSource?: () => Promise<ResolvedProvisionToken | null>;
  secretStore?: {
    put?: (name: string, value: string, input: Record<string, unknown>) => Promise<unknown>;
    describe?: (name: string) => Promise<unknown>;
  } | null;
  envTokenConfigured?: boolean;
  idpStatus?: number;
  idpBody?: unknown;
} = {}) {
  const calls: { put?: { name: string; value: string; input: Record<string, unknown> } } = {};
  const requireOperator = (capability: string): MiddlewareHandler<AppBindings> => {
    return async (c, next) => {
      const caps = overrides.capabilities ?? ["subscription.manage", "quota.read"];
      if (!caps.includes(capability)) {
        return c.json({ error: "forbidden" }, 403);
      }
      c.set("platformOperator", { subject: "ops-1", kind: "human", capabilities: caps as never });
      await next();
    };
  };
  const store = overrides.secretStore === null
    ? null
    : {
        put: async (name: string, value: string, input: Record<string, unknown>) => {
          calls.put = { name, value, input };
          return { name, purpose: "p", updatedAt: "2026-01-02T03:04:05Z", updatedBy: String(input.actor) };
        },
        describe: async () => null,
        ...overrides.secretStore,
      };
  const fetchImpl = async () =>
    new Response(JSON.stringify(overrides.idpBody ?? { tenants: [{ id: "t-1", slug: "ck" }] }), {
      status: overrides.idpStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  const app = new Hono<AppBindings>()
    .onError(handleError)
    .route("/", createOpsProvisionTokenRoutes({
      tokenSource: overrides.tokenSource ?? (async () => ({ token: VALID_TOKEN, source: "env" as const })),
      secretStore: store as never,
      envTokenConfigured: overrides.envTokenConfigured ?? true,
      baseUrl: "https://o.maplayer.top",
      tenantSlug: "ck",
      fetchImpl,
      requireOperator: requireOperator as never,
    }));
  return { app, calls };
}

describe("ops provision-token 轮换路由", () => {
  test("POST 无 subscription.manage → 403", async () => {
    const { app } = makeApp({ capabilities: ["quota.read"] });
    const res = await app.request("/api/ops/idp-provision-token/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(403);
  });

  test("POST 非法 body（缺 token / 格式不符）→ 400 invalid-request", async () => {
    const { app } = makeApp();
    for (const body of [{}, { token: "short" }, { token: "bad chars!!!" + "x".repeat(40) }]) {
      const res = await app.request("/api/ops/idp-provision-token/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("idp-provision-token-invalid-request");
    }
  });

  test("POST 密封仓未装配（PLATFORM_SECRET_KEY 缺省）→ 503", async () => {
    const { app } = makeApp({ secretStore: null });
    const res = await app.request("/api/ops/idp-provision-token/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("idp-provision-store-not-configured");
  });

  test("POST IdP 探测拒绝候选 token → 400 invalid，不写密封仓", async () => {
    const { app, calls } = makeApp({ idpStatus: 403, idpBody: { error: "forbidden" } });
    const res = await app.request("/api/ops/idp-provision-token/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("idp-provision-token-invalid");
    expect(calls.put).toBeUndefined();
  });

  test("POST 成功：先探测后密封，actor 归因，响应不含 token 明文", async () => {
    const { app, calls } = makeApp();
    const res = await app.request("/api/ops/idp-provision-token/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ rotated: true, source: "store", updatedBy: "ops-1" });
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
    expect(calls.put?.name).toBe("idp_provision_token");
    expect(calls.put?.value).toBe(VALID_TOKEN);
    expect(calls.put?.input).toMatchObject({ actor: "ops-1", action: "rotate", source: "ops_api" });
    expect(JSON.stringify(calls.put?.input.detail)).not.toContain(VALID_TOKEN);
  });

  test("GET status：store 优先 + IdP 探测成功", async () => {
    const { app } = makeApp({
      tokenSource: async () => ({ token: VALID_TOKEN, source: "store" as const }),
      secretStore: { describe: async () => ({ updatedAt: "2026-01-02T03:04:05Z", updatedBy: "ops-1", purpose: "p" }) },
    });
    const res = await app.request("/api/ops/idp-provision-token/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      source: "store",
      env: { configured: true },
      store: { sealKeyConfigured: true, entry: { updatedBy: "ops-1" }, unsealError: null },
      idp: { reachable: true },
    });
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });

  test("GET status：未配置 → configured:false，env 兜底缺失亦可见", async () => {
    const { app } = makeApp({
      tokenSource: async () => null,
      envTokenConfigured: false,
      secretStore: {},
    });
    const res = await app.request("/api/ops/idp-provision-token/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: false,
      source: null,
      env: { configured: false },
      store: { entry: null },
      idp: { reachable: false },
    });
  });

  test("GET status：现行 token 被 IdP 吊销 → reachable:false + 403 状态透出", async () => {
    const { app } = makeApp({ idpStatus: 403, idpBody: { error: "forbidden" } });
    const res = await app.request("/api/ops/idp-provision-token/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      idp: { reachable: false, status: 403 },
    });
  });

  test("GET status 无 quota.read → 403", async () => {
    const { app } = makeApp({ capabilities: ["subscription.manage"] });
    const res = await app.request("/api/ops/idp-provision-token/status");
    expect(res.status).toBe(403);
  });
});
