import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { handleError } from "../middleware/error";
import { RolloutError, RolloutGateService } from "../rollout/service";
import { createOpsRolloutRoutes } from "./ops-rollout";

/** 与 product-entitlement.test.ts 同约：能力集合每请求重核，撤销即 403。 */
function operatorHarness(caps: PlatformOperatorCapability[]) {
  const liveCaps = new Set<string>(caps);
  const requireOperator = (capability?: PlatformOperatorCapability): MiddlewareHandler<AppBindings> => async (c, next) => {
    if (capability && !liveCaps.has(capability)) {
      throw new HttpError(403, "platform-operator-capability", "缺少所需平台运营能力");
    }
    c.set("platformOperator", { subject: "ops", capabilities: [...liveCaps] as PlatformOperatorCapability[] });
    await next();
  };
  return { liveCaps, requireOperator };
}

const READ_WRITE: PlatformOperatorCapability[] = ["quota.read", "rollout.manage"];

function buildApp(opts: {
  caps?: PlatformOperatorCapability[];
  service?: Partial<RolloutGateService>;
} = {}) {
  const harness = operatorHarness(opts.caps ?? READ_WRITE);
  const service = {
    gateCatalog: () => [
      { gate: "legal_content_access", label: "内容" },
      { gate: "legal_research_ai", label: "AI" },
    ],
    listBatches: async () => [],
    getBatch: async () => { throw new RolloutError("not_found", "批次不存在"); },
    workspaceStatus: async () => ({ workspaceSlug: "accept-a", gates: [], activeBatches: [], recentOperations: [] }),
    setGate: async () => ({ gate: "legal_content_access", label: "x", state: "disabled", revision: 1, updatedAt: null, updatedBy: null, reason: null, batchKey: null }),
    registerBatch: async () => ({}),
    transitionBatch: async () => ({}),
    ...opts.service,
  } as unknown as RolloutGateService;
  const app = new Hono<AppBindings>()
    .route("/", createOpsRolloutRoutes({ service, requireOperator: harness.requireOperator }))
    .onError(handleError);
  return { app };
}

const post = (app: Hono<AppBindings>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("LCA14 /api/ops/rollout 路由", () => {
  test("GET gates 返回固定开关目录（quota.read）", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/ops/rollout/gates");
    expect(res.status).toBe(200);
    expect((await res.json()).gates.map((g: { gate: string }) => g.gate)).toEqual([
      "legal_content_access", "legal_research_ai",
    ]);
  });

  test("写端点缺 rollout.manage → 403；只读端点 quota.read 即可", async () => {
    const { app } = buildApp({ caps: ["quota.read"] });
    expect((await app.request("/api/ops/rollout/batches")).status).toBe(200);
    expect((await post(app, "/api/ops/rollout/batches", {})).status).toBe(403);
    expect((await post(app, "/api/ops/rollout/workspaces/accept-a/gates", {
      gate: "legal_content_access", action: "disable", reason: "r", idempotencyKey: "idem-12345678",
    })).status).toBe(403);
  });

  test("非法 body → 400 rollout-invalid_request", async () => {
    const { app } = buildApp();
    const res = await post(app, "/api/ops/rollout/workspaces/accept-a/gates", {
      gate: "bogus", action: "disable", reason: "r", idempotencyKey: "idem-12345678",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("rollout-invalid_request");
  });

  test("RolloutError 映射：not_found→404、conflict→409、scope_denied/forbidden→403", async () => {
    const { app } = buildApp({
      service: {
        getBatch: async () => { throw new RolloutError("not_found", "x"); },
        transitionBatch: async () => { throw new RolloutError("conflict", "x"); },
        setGate: async () => { throw new RolloutError("scope_denied", "不在受控名单"); },
      },
    });
    expect((await app.request("/api/ops/rollout/batches/none")).status).toBe(404);
    expect((await post(app, "/api/ops/rollout/batches/b1/status", {
      status: "active", reason: "r", idempotencyKey: "idem-12345678",
    })).status).toBe(409);
    const denied = await post(app, "/api/ops/rollout/workspaces/outside/gates", {
      gate: "legal_content_access", action: "restore", reason: "r", idempotencyKey: "idem-12345678",
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("rollout-scope_denied");
  });

  test("POST workspace gates 成功路径把 actor/slug/body 交给 service", async () => {
    const calls: { slug?: string; actor?: string }[] = [];
    const { app } = buildApp({
      service: {
        setGate: async (actor, slug, input) => {
          calls.push({ slug, actor: actor.subject });
          expect(input.gate).toBe("legal_content_access");
          return { gate: "legal_content_access", label: "x", state: "disabled", revision: 1, updatedAt: null, updatedBy: null, reason: null, batchKey: null };
        },
      },
    });
    const res = await post(app, "/api/ops/rollout/workspaces/accept-a/gates", {
      gate: "legal_content_access", action: "disable", reason: "关闭验证", idempotencyKey: "idem-abcdefgh",
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ slug: "accept-a", actor: "ops" }]);
    expect((await res.json()).state).toBe("disabled");
  });
});
