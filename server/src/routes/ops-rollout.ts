import { Hono } from "hono";
import {
  registerRolloutBatchSchema,
  setWorkspaceRolloutGateSchema,
  updateRolloutBatchStatusSchema,
} from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { RolloutError, type RolloutActor, RolloutGateService } from "../rollout/service";

function fail(error: unknown): never {
  if (!(error instanceof RolloutError)) throw error;
  const status = error.code === "not_found" ? 404
    : error.code === "conflict" ? 409
    : error.code === "invalid_request" ? 400
    : 403;
  throw new HttpError(status, `rollout-${error.code}`, error.message);
}

function operator(c: { var: AppBindings["Variables"] }): RolloutActor {
  const current = c.var.platformOperator;
  if (!current) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  return { subject: current.subject, capabilities: current.capabilities };
}

/**
 * LCA14 受控灰度开关与具名批次（ops 控制面）。
 * 读 = quota.read；写（开关切换、批次登记/流转）= rollout.manage。
 * 客户端为运维代理 ops_request 与 ops 前端；每次调用落 rollout_operation 审计。
 */
export function createOpsRolloutRoutes(input: {
  service: RolloutGateService;
  requireOperator?: typeof requirePlatformOperator;
}) {
  const requireOperator = input.requireOperator ?? requirePlatformOperator;
  return new Hono<AppBindings>()
    .get("/api/ops/rollout/gates", requireOperator("quota.read"), (c) => {
      return c.json({ gates: input.service.gateCatalog() });
    })
    .get("/api/ops/rollout/batches", requireOperator("quota.read"), async (c) => {
      try {
        const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
        return c.json({ batches: await input.service.listBatches(operator(c), limit) });
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/rollout/batches/:key", requireOperator("quota.read"), async (c) => {
      try {
        return c.json(await input.service.getBatch(operator(c), c.req.param("key")));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/rollout/batches", requireOperator("rollout.manage"), async (c) => {
      const parsed = registerRolloutBatchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "rollout-invalid_request", "批次登记请求无效");
      try {
        return c.json(await input.service.registerBatch(operator(c), parsed.data), 201);
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/rollout/batches/:key/status", requireOperator("rollout.manage"), async (c) => {
      const parsed = updateRolloutBatchStatusSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "rollout-invalid_request", "批次流转请求无效");
      try {
        return c.json(await input.service.transitionBatch(operator(c), c.req.param("key"), parsed.data));
      } catch (error) {
        return fail(error);
      }
    })
    .get("/api/ops/rollout/workspaces/:slug", requireOperator("quota.read"), async (c) => {
      try {
        return c.json(await input.service.workspaceStatus(operator(c), c.req.param("slug")));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/api/ops/rollout/workspaces/:slug/gates", requireOperator("rollout.manage"), async (c) => {
      const parsed = setWorkspaceRolloutGateSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "rollout-invalid_request", "开关操作请求无效");
      try {
        return c.json(await input.service.setGate(operator(c), c.req.param("slug"), parsed.data));
      } catch (error) {
        return fail(error);
      }
    });
}
