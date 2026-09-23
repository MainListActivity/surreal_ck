import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  shareActivationSummarySchema,
  withdrawActivationSummarySchema,
} from "@surreal-ck/shared";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { requirePlatformOperator } from "../ops/operator-auth";
import { OpsAutonomyError } from "../ops-autonomy/service";
import { autonomyHttpError } from "./ops-autonomy";
import {
  ActivationSummaryService,
  ActivationSummaryServiceError,
} from "../activation-summary/service";

function asHttpError(error: unknown): never {
  if (error instanceof OpsAutonomyError) return autonomyHttpError(error);
  if (!(error instanceof ActivationSummaryServiceError)) throw error;
  const status = error.code === "forbidden" || error.code === "capability_missing"
    ? 403
    : error.code === "not_found"
      ? 404
      : 400;
  throw new HttpError(status, `activation-summary-${error.code}`, error.message);
}

function operator(c: { var: AppBindings["Variables"] }) {
  const actor = c.var.platformOperator;
  if (!actor) throw new HttpError(403, "platform-operator-required", "需要平台运营身份");
  const scopeClaim = c.var.user?.raw?.scope;
  const scopes = typeof scopeClaim === "string"
    ? new Set(scopeClaim.split(/\s+/u).filter(Boolean))
    : null;
  return {
    subject: actor.subject,
    kind: actor.kind,
    capabilities: scopes === null
      ? actor.kind === "agent" ? [] : actor.capabilities
      : actor.capabilities.filter((capability) => scopes.has(capability)),
  };
}

export function createActivationSummaryRoutes(input: Readonly<{
  service: ActivationSummaryService;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireUser = input.requireUser ?? requireOidc;
  const requireOperator = input.requireOperator
    ?? (() => requirePlatformOperator("activation.summary.read"));

  return new Hono<AppBindings>()
    .post("/api/workspaces/:slug/activation-summary", requireUser(), async (c) => {
      const parsed = shareActivationSummarySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "activation-summary-invalid-request", "摘要请求无效");
      try {
        return c.json(await input.service.share({
          workspaceSlug: c.req.param("slug"),
          actorSubject: c.var.user.subject,
          summary: parsed.data.summary,
          idempotencyKey: parsed.data.idempotencyKey,
        }));
      } catch (error) {
        return asHttpError(error);
      }
    })
    .delete("/api/workspaces/:slug/activation-summary", requireUser(), async (c) => {
      const parsed = withdrawActivationSummarySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "activation-summary-invalid-request", "撤回请求无效");
      try {
        return c.json(await input.service.withdraw({
          workspaceSlug: c.req.param("slug"),
          actorSubject: c.var.user.subject,
          idempotencyKey: parsed.data.idempotencyKey,
        }));
      } catch (error) {
        return asHttpError(error);
      }
    })
    .get("/api/ops/activation-summaries", requireOperator(), async (c) => {
      try {
        return c.json(await input.service.list(operator(c), {
          limit: Number(c.req.query("limit") || "20"),
          cursor: c.req.query("cursor"),
        }));
      } catch (error) {
        return asHttpError(error);
      }
    })
    .get("/api/ops/activation-summaries/:summaryId", requireOperator(), async (c) => {
      try {
        return c.json(await input.service.get(operator(c), c.req.param("summaryId")));
      } catch (error) {
        return asHttpError(error);
      }
    });
}
