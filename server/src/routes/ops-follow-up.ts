import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { claimFollowUpSchema, createFollowUpSchema, updateFollowUpSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { OpsFollowUpService, OpsFollowUpServiceError } from "../ops-follow-up/service";

function asHttpError(error: unknown): never {
  if (!(error instanceof OpsFollowUpServiceError)) throw error;
  const status = error.code === "capability_missing" ? 403 : error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
  throw new HttpError(status, `ops-follow-up-${error.code}`, error.message);
}

function actor(c: { var: AppBindings["Variables"] }) {
  const operator = c.var.platformOperator;
  if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  const rawScope = c.var.user?.raw?.scope;
  const scopes = typeof rawScope === "string" ? new Set(rawScope.split(/\s+/u).filter(Boolean)) : null;
  return {
    subject: operator.subject,
    capabilities: scopes ? operator.capabilities.filter((capability) => scopes.has(capability)) : operator.capabilities,
  };
}

export function createOpsFollowUpRoutes(input: Readonly<{
  service: OpsFollowUpService;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("activation.followup.read"));
  const app = new Hono<AppBindings>();

  app.get("/api/ops/activation-opportunities", requireOperator(), async (c) => {
    try {
      return c.json(await input.service.listOpportunities(actor(c), { limit: Number(c.req.query("limit") || "20"), cursor: c.req.query("cursor") }));
    } catch (error) { return asHttpError(error); }
  });
  app.get("/api/ops/follow-ups", requireOperator(), async (c) => {
    try {
      return c.json(await input.service.listFollowUps(actor(c), { limit: Number(c.req.query("limit") || "20"), cursor: c.req.query("cursor") }));
    } catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/follow-ups", requireOperator(), async (c) => {
    const parsed = createFollowUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-follow-up-invalid-request", "创建跟进事项请求无效");
    try { return c.json(await input.service.create(actor(c), parsed.data), 201); }
    catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/follow-ups/:followUpId/claim", requireOperator(), async (c) => {
    const parsed = claimFollowUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-follow-up-invalid-request", "认领请求无效");
    try { return c.json(await input.service.claim(actor(c), { followUpId: c.req.param("followUpId"), ...parsed.data })); }
    catch (error) { return asHttpError(error); }
  });
  app.patch("/api/ops/follow-ups/:followUpId", requireOperator(), async (c) => {
    const parsed = updateFollowUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-follow-up-invalid-request", "更新请求无效");
    try { return c.json(await input.service.update(actor(c), { followUpId: c.req.param("followUpId"), ...parsed.data })); }
    catch (error) { return asHttpError(error); }
  });
  return app;
}
