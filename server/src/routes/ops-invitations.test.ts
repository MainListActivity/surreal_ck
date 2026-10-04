import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { createOpsInvitationRoutes } from "./ops-invitations";
import { InviteError, type InviteResult } from "../invitations/invite-service";

function makeApp(overrides: {
  provision?: (input: unknown) => Promise<InviteResult>;
  get?: (key: string) => Promise<InviteResult | null>;
  capabilities?: string[];
} = {}) {
  const calls: { provision?: unknown } = {};
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
  const app = new Hono<AppBindings>()
    .onError(handleError)
    .route("/", createOpsInvitationRoutes({
      service: {
        provision: async (_actor: unknown, input: unknown) => {
          calls.provision = input;
          return overrides.provision ? overrides.provision(input) : ({} as InviteResult);
        },
        get: async (key: string) => overrides.get ? overrides.get(key) : null,
      } as never,
      requireOperator: requireOperator as never,
    }));
  return { app, calls };
}

const BODY = {
  email: "lawyer@example.com",
  displayName: "陈律师",
  workspaceSlug: "acme-bankruptcy",
  planKey: "pro",
  aiAllowance: { amount: 500, expiresAt: "2099-01-01T00:00:00Z", label: "邀请试点 AI 额度" },
  reason: "G2 试点邀请",
  idempotencyKey: "invite-route-001",
};

describe("G2 ops 邀请路由", () => {
  test("POST 合法请求 → service.provision + 201", async () => {
    const result = { status: "completed", replayed: false } as InviteResult;
    const { app, calls } = makeApp({ provision: async () => result });
    const res = await app.request("/api/ops/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(201);
    expect(calls.provision).toMatchObject({ email: "lawyer@example.com", workspaceSlug: "acme-bankruptcy" });
  });

  test("重放结果 → 200", async () => {
    const { app } = makeApp({ provision: async () => ({ replayed: true } as InviteResult) });
    const res = await app.request("/api/ops/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(200);
  });

  test("缺字段/坏邮箱 → 400 invite-invalid-request", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/ops/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BODY, email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invite-invalid-request");
  });

  test("InviteError 映射：conflict→409 / not-configured→503 / slug-taken→409", async () => {
    for (const [code, status] of [["invite-conflict", 409], ["invite-idp-not-configured", 503], ["invite-slug-taken", 409], ["invite-in-progress", 409]] as const) {
      const { app } = makeApp({ provision: async () => { throw new InviteError(code, "m"); } });
      const res = await app.request("/api/ops/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(BODY),
      });
      expect(res.status).toBe(status);
    }
  });

  test("无 subscription.manage 能力 → 403（不触达 service）", async () => {
    let hit = false;
    const { app } = makeApp({
      capabilities: ["quota.read"],
      provision: async () => { hit = true; return {} as InviteResult; },
    });
    const res = await app.request("/api/ops/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(403);
    expect(hit).toBe(false);
  });

  test("GET 幂等键查询：存在→200，不存在→404", async () => {
    const { app } = makeApp({ get: async () => ({ status: "completed" } as InviteResult) });
    expect((await app.request("/api/ops/invitations/k1")).status).toBe(200);
    const missing = makeApp({ get: async () => null });
    const res = await missing.app.request("/api/ops/invitations/none");
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invite-not-found");
  });
});
