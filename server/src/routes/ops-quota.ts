import type {
  ControlPlaneObject,
  PlatformOperatorCapability,
  QuotaOperatorIntentKind,
} from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import {
  QuotaLifecycleError,
  requiredCapabilityForIntent,
  type OperatorIntentSubmission,
} from "../quota/subscription-lifecycle";
import {
  QuotaRefreshRateLimitError,
} from "../quota/quota-info-cache";
import type { QuotaReadPort } from "./quota";
import type { QuotaIntentStatusReader } from "../quota/quota-intent-status";

export interface QuotaOperatorIntentPort {
  submitOperatorIntent(
    input: OperatorIntentSubmission,
  ): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    intent: StringRecordId;
  }>>;
}

const INTENT_KINDS = new Set<QuotaOperatorIntentKind>([
  "subscription_upsert",
  "subscription_end",
  "override_schedule",
  "override_end",
  "reconcile_now",
  "audit_now",
  "drift_reapply",
  "drift_to_override",
  "ledger_rebuild",
  "materialization_retry",
  "provisioning_retry",
  "provisioning_cleanup",
  "auto_reconcile_pause",
  "auto_reconcile_resume",
]);

function recordId(
  value: unknown,
  table: "workspace" | "billing_account",
): StringRecordId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.startsWith(`${table}:`)) {
    throw new HttpError(
      400,
      "quota-intent-target-invalid",
      `${table} must be a typed record id`,
    );
  }
  try {
    return new StringRecordId(value);
  } catch {
    throw new HttpError(
      400,
      "quota-intent-target-invalid",
      `${table} must be a typed record id`,
    );
  }
}

function object(
  value: unknown,
  field: string,
  fallback?: ControlPlaneObject,
): ControlPlaneObject {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      "quota-intent-input-invalid",
      `${field} must be an object`,
    );
  }
  return value as ControlPlaneObject;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw new HttpError(
      400,
      "quota-intent-input-invalid",
      `${field} must be 1-${maxLength} characters`,
    );
  }
  return text;
}

function effectiveAt(value: unknown): DateTime {
  const iso =
    value === undefined
      ? new Date().toISOString()
      : typeof value === "string"
        ? value
        : "";
  if (!iso || Number.isNaN(Date.parse(iso))) {
    throw new HttpError(
      400,
      "quota-intent-effective-at-invalid",
      "effectiveAt must be an ISO datetime",
    );
  }
  return new DateTime(new Date(iso).toISOString());
}

function lifecycleHttpError(error: QuotaLifecycleError): HttpError {
  if (error.code === "operator_capability_mismatch") {
    return new HttpError(403, error.code, "Operator capability is insufficient");
  }
  if (error.code.includes("conflict")) {
    return new HttpError(409, error.code, error.message);
  }
  return new HttpError(
    error.retryable ? 503 : 400,
    error.code,
    error.message,
  );
}

export function createOpsQuotaRoutes(input: Readonly<{
  reads: QuotaReadPort;
  intents: QuotaOperatorIntentPort;
  intentStatus: QuotaIntentStatusReader;
  requireUser?: () => MiddlewareHandler<AppBindings>;
}>) {
  const requireUser = input.requireUser ?? requireOidc;
  return new Hono<AppBindings>()
    .get("/api/ops/quota/workspaces/:slug", requireUser(), async (c) => {
      try {
        const result = await input.reads.getWorkspace({
          slug: c.req.param("slug"),
          actor: {
            subject: c.var.user.subject,
            ...(c.var.user.email ? { email: c.var.user.email } : {}),
          },
          force:
            c.req.query("refresh") === "true"
            || c.req.query("refresh") === "1",
        });
        if (result.kind === "not_found" || result.view.view !== "operator") {
          throw new HttpError(
            404,
            "quota-ops-workspace-not-found",
            "Workspace does not exist or is not accessible",
          );
        }
        return c.json(result.view);
      } catch (error) {
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
    })
    .get("/api/ops/quota/intents/:intentId", requireUser(), async (c) => {
      const raw = c.req.param("intentId");
      if (!raw.startsWith("quota_operator_intent:")) {
        throw new HttpError(
          404,
          "quota-intent-not-found",
          "Quota intent does not exist or is not accessible",
        );
      }
      let intent: StringRecordId;
      try {
        intent = new StringRecordId(raw);
      } catch {
        throw new HttpError(
          404,
          "quota-intent-not-found",
          "Quota intent does not exist or is not accessible",
        );
      }
      const status = await input.intentStatus.get({
        intent,
        actorSubject: c.var.user.subject,
      });
      if (!status) {
        throw new HttpError(
          404,
          "quota-intent-not-found",
          "Quota intent does not exist or is not accessible",
        );
      }
      return c.json(status);
    })
    .post("/api/ops/quota/intents", requireUser(), async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!body || !INTENT_KINDS.has(body.kind)) {
        throw new HttpError(
          400,
          "quota-intent-kind-invalid",
          "kind is not a supported quota operator intent",
        );
      }
      const kind = body.kind as QuotaOperatorIntentKind;
      const capability: PlatformOperatorCapability =
        requiredCapabilityForIntent(kind);
      const requestId = requiredText(body.requestId, "requestId", 128);
      const workspace = recordId(body.workspace, "workspace");
      const billingAccount = recordId(
        body.billingAccount,
        "billing_account",
      );
      const submission: OperatorIntentSubmission = {
        kind,
        actorSubject: c.var.user.subject,
        actorCapability: capability,
        requestId,
        ...(workspace ? { workspace } : {}),
        ...(billingAccount ? { billingAccount } : {}),
        customerReason: requiredText(
          body.customerReason,
          "customerReason",
          500,
        ),
        operatorReason: requiredText(
          body.operatorReason,
          "operatorReason",
          2_000,
        ),
        effectiveAt: effectiveAt(body.effectiveAt),
        input: object(body.input, "input", {}),
        impactPreview: object(body.impactPreview, "impactPreview", {}),
        ...(typeof body.beforeDigest === "string" && body.beforeDigest.length > 0
          ? { beforeDigest: body.beforeDigest }
          : {}),
        correlationId:
          typeof body.correlationId === "string"
          && body.correlationId.length > 0
            ? body.correlationId
            : requestId,
        ...(typeof body.causationId === "string" && body.causationId.length > 0
          ? { causationId: body.causationId }
          : {}),
      };

      try {
        const result = await input.intents.submitOperatorIntent(submission);
        const id = result.intent.toString();
        return c.json(
          {
            id,
            status: result.kind === "accepted" ? "accepted" : "duplicate",
            statusUrl: `/api/ops/quota/intents/${encodeURIComponent(id)}`,
          },
          202,
        );
      } catch (error) {
        if (error instanceof QuotaLifecycleError) {
          throw lifecycleHttpError(error);
        }
        throw error;
      }
    });
}
