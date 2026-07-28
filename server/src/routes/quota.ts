import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import {
  QuotaRefreshRateLimitError,
} from "../quota/quota-info-cache";
import type {
  QuotaBillingReadResult,
  QuotaReadActor,
  QuotaReadResult,
} from "../quota/quota-read-service";

export interface QuotaReadPort {
  getWorkspace(input: Readonly<{
    slug: string;
    actor: QuotaReadActor;
    force?: boolean;
  }>): Promise<QuotaReadResult>;
  getBillingAccount(input: Readonly<{
    accountKey: string;
    actor: QuotaReadActor;
    force?: boolean;
  }>): Promise<QuotaBillingReadResult>;
}

function forceRefresh(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function quotaReadError(error: unknown): never {
  if (error instanceof QuotaRefreshRateLimitError) {
    throw new HttpError(
      429,
      "quota-refresh-rate-limited",
      "Quota refresh is rate limited",
      { retryAfterMs: error.retryAfterMs },
    );
  }
  throw error;
}

export function createQuotaRoutes(
  service: QuotaReadPort,
  requireUser: () => MiddlewareHandler<AppBindings> = requireOidc,
) {
  return new Hono<AppBindings>()
    .get("/api/workspaces/:slug/quota", requireUser(), async (c) => {
      try {
        const result = await service.getWorkspace({
          slug: c.req.param("slug"),
          actor: {
            subject: c.var.user.subject,
            ...(c.var.user.email ? { email: c.var.user.email } : {}),
          },
          force: forceRefresh(c.req.query("refresh")),
        });
        if (result.kind === "not_found") {
          throw new HttpError(
            404,
            "quota-workspace-not-found",
            "Workspace does not exist or is not accessible",
          );
        }
        return c.json(result.view);
      } catch (error) {
        return quotaReadError(error);
      }
    })
    .get("/api/billing-accounts/:accountKey/quota", requireUser(), async (c) => {
      try {
        const result = await service.getBillingAccount({
          accountKey: c.req.param("accountKey"),
          actor: {
            subject: c.var.user.subject,
            ...(c.var.user.email ? { email: c.var.user.email } : {}),
          },
          force: forceRefresh(c.req.query("refresh")),
        });
        if (result.kind === "not_found") {
          throw new HttpError(
            404,
            "quota-billing-account-not-found",
            "Billing account does not exist or is not accessible",
          );
        }
        return c.json(result.view);
      } catch (error) {
        return quotaReadError(error);
      }
    });
}
