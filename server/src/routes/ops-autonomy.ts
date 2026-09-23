import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { changeOpsAutonomyStatusSchema, configureOpsAutonomySchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { OpsAutonomyError, OpsAutonomyService, type OpsAutonomyActor } from "../ops-autonomy/service";

export function autonomyHttpError(error: unknown): never {
  if (!(error instanceof OpsAutonomyError)) throw error;
  const status = error.code === "paused" ? 423 : error.code === "not_found" ? 404
    : error.code === "conflict" ? 409 : error.code === "invalid_request" ? 400 : 403;
  throw new HttpError(status, `ops-autonomy-${error.code}`, error.message);
}
function actor(c: { var: AppBindings["Variables"] }): OpsAutonomyActor {
  const operator = c.var.platformOperator;
  if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  const scope = c.var.user?.raw?.scope;
  const scopes = typeof scope === "string" ? new Set(scope.split(/\s+/u).filter(Boolean)) : null;
  return { subject: operator.subject, kind: operator.kind,
    capabilities: scopes ? operator.capabilities.filter((capability) => scopes.has(capability)) : operator.capabilities };
}
export function createOpsAutonomyRoutes(input: { service: OpsAutonomyService; requireOperator?: () => MiddlewareHandler<AppBindings> }) {
  const app = new Hono<AppBindings>();
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("activation.autonomy.read"));
  app.get("/api/ops/autonomy/policies", requireOperator(), async (c) => {
    try { return c.json(await input.service.list(actor(c), c.req.query("agentSubject"))); }
    catch (error) { return autonomyHttpError(error); }
  });
  app.get("/api/ops/autonomy/history", requireOperator(), async (c) => {
    try { return c.json(await input.service.history(actor(c), c.req.query("policyId"))); }
    catch (error) { return autonomyHttpError(error); }
  });
  app.put("/api/ops/autonomy/policies", requireOperator(), async (c) => {
    const parsed = configureOpsAutonomySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-autonomy-invalid-request", "自治配置无效");
    try { return c.json(await input.service.configure(actor(c), parsed.data)); }
    catch (error) { return autonomyHttpError(error); }
  });
  app.post("/api/ops/autonomy/policies/:policyId/status", requireOperator(), async (c) => {
    const body = await c.req.json().catch(() => null);
    const status = body && typeof body === "object" && "status" in body ? body.status : null;
    const parsed = changeOpsAutonomyStatusSchema.safeParse(body && typeof body === "object" ? {
      expectedVersion: body.expectedVersion, reason: body.reason, idempotencyKey: body.idempotencyKey,
    } : null);
    if (!parsed.success || (status !== "active" && status !== "paused" && status !== "revoked")) throw new HttpError(400, "ops-autonomy-invalid-request", "状态变更请求无效");
    try { return c.json(await input.service.changeStatus(actor(c), { policyId: c.req.param("policyId"), ...parsed.data, status })); }
    catch (error) { return autonomyHttpError(error); }
  });
  return app;
}
