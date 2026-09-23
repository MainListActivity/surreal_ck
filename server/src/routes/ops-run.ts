import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { saveOpsRunSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { OpsAutonomyError } from "../ops-autonomy/service";
import { OpsRunError, OpsRunService } from "../ops-run/service";
import { autonomyHttpError } from "./ops-autonomy";

function fail(error: unknown): never {
  if (error instanceof OpsAutonomyError) return autonomyHttpError(error);
  if (!(error instanceof OpsRunError)) throw error;
  const status = error.code === "invalid_request" ? 400 : error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 403;
  throw new HttpError(status, `ops-run-${error.code}`, error.message);
}
export function createOpsRunRoutes(input: { service: OpsRunService; requireOperator?: () => MiddlewareHandler<AppBindings> }) {
  const app = new Hono<AppBindings>();
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator());
  const actor = (c: { var: AppBindings["Variables"] }) => {
    const operator = c.var.platformOperator;
    if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
    const rawScope = c.var.user?.raw?.scope;
    const scope = typeof rawScope === "string" ? new Set(rawScope.split(/\s+/u).filter(Boolean)) : null;
    return { subject: operator.subject, kind: operator.kind,
      capabilities: scope ? operator.capabilities.filter((item) => scope.has(item)) : operator.kind === "agent" ? [] : operator.capabilities };
  };
  app.get("/api/ops/agent-runs", requireOperator(), async (c) => {
    try { return c.json(await input.service.list(actor(c))); } catch (error) { return fail(error); }
  });
  app.get("/api/ops/agent-runs/checkpoint", requireOperator(), async (c) => {
    try { return c.json(await input.service.get(actor(c), c.req.query("workspaceSlug") ?? "", c.req.query("runKey") ?? "")); }
    catch (error) { return fail(error); }
  });
  app.put("/api/ops/agent-runs/checkpoint", requireOperator(), async (c) => {
    const parsed = saveOpsRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-run-invalid-request", "运行检查点无效");
    try { return c.json(await input.service.save(actor(c), parsed.data)); } catch (error) { return fail(error); }
  });
  return app;
}
