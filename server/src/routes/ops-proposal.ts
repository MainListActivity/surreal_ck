import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { executeOpsProposalSchema, reviewOpsProposalSchema, submitOpsProposalSchema, takeoverFollowUpSchema } from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import { OpsProposalService, OpsProposalServiceError, type OpsProposalActor } from "../ops-proposal/service";

function asHttpError(error: unknown): never {
  if (!(error instanceof OpsProposalServiceError)) throw error;
  const status = error.code === "capability_missing" ? 403 : error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
  throw new HttpError(status, `ops-proposal-${error.code}`, error.message);
}
function actor(c: { var: AppBindings["Variables"] }): OpsProposalActor {
  const operator = c.var.platformOperator;
  if (!operator) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  const raw = c.var.user?.raw;
  const scope = typeof raw?.scope === "string" ? new Set(raw.scope.split(/\s+/u).filter(Boolean)) : null;
  const act = raw?.act;
  const delegatedAgentId = act && typeof act === "object" && "sub" in act && typeof act.sub === "string" ? act.sub : null;
  const agentId = operator.kind === "agent" ? delegatedAgentId ?? operator.subject : delegatedAgentId;
  return { subject: operator.subject, kind: operator.kind, capabilities: scope ? operator.capabilities.filter((capability) => scope.has(capability)) : operator.capabilities, agentId };
}
export function createOpsProposalRoutes(input: { service: OpsProposalService; requireOperator?: () => MiddlewareHandler<AppBindings> }) {
  const app = new Hono<AppBindings>();
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("activation.proposal.read"));
  app.get("/api/ops/proposals", requireOperator(), async (c) => {
    try { return c.json(await input.service.list(actor(c), { limit: Number(c.req.query("limit") || "20"), cursor: c.req.query("cursor") })); }
    catch (error) { return asHttpError(error); }
  });
  app.get("/api/ops/proposals/:proposalId", requireOperator(), async (c) => {
    try { return c.json(await input.service.get(actor(c), c.req.param("proposalId"))); }
    catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/proposals", requireOperator(), async (c) => {
    const parsed = submitOpsProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-proposal-invalid-request", "建议请求无效");
    try { return c.json(await input.service.submit(actor(c), parsed.data), 201); }
    catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/proposals/:proposalId/review", requireOperator(), async (c) => {
    const parsed = reviewOpsProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-proposal-invalid-request", "审阅请求无效");
    try { return c.json(await input.service.review(actor(c), { proposalId: c.req.param("proposalId"), ...parsed.data })); }
    catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/proposals/:proposalId/execute", requireOperator(), async (c) => {
    const parsed = executeOpsProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-proposal-invalid-request", "执行请求无效");
    try { return c.json(await input.service.execute(actor(c), { proposalId: c.req.param("proposalId"), ...parsed.data })); }
    catch (error) { return asHttpError(error); }
  });
  app.post("/api/ops/follow-ups/:followUpId/takeover", requireOperator(), async (c) => {
    const parsed = takeoverFollowUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "ops-proposal-invalid-request", "接管请求无效");
    try { return c.json(await input.service.takeover(actor(c), { followUpId: c.req.param("followUpId"), ...parsed.data })); }
    catch (error) { return asHttpError(error); }
  });
  return app;
}
