import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { RecordId, StringRecordId } from "surrealdb";
import type { AppBindings } from "../hono-types";
import { requireOidc } from "../middleware/oidc";
import { requirePlatformOperator } from "../ops/operator-auth";
import { HttpError } from "../http-error";
import { getRootDatabaseSession } from "../db/root-connection";
import type { ProTrialService } from "../workspaces/pro-trial";

const startSchema = z.object({ accountKey: z.string().min(1).max(200), name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/), key: z.string().min(1).max(128), offerRevision: z.string().startsWith("pro_trial_revision:") }).strict();
const configSchema = z.object({ revisionKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), productRevision: z.string().startsWith("product_plan_revision:"),
  researchRate: z.number().int().positive(), rateRevision: z.number().int().min(2), reminderHours: z.array(z.number().int().min(1).max(167)).max(10), fixture: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict();
const eligibilitySchema = z.object({ accountKey: z.string().min(1).max(200), enabled: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict();

export function createProTrialRoutes(service: ProTrialService, requireUser: () => MiddlewareHandler<AppBindings> = requireOidc) {
  return new Hono<AppBindings>()
    .get("/api/workspaces/:slug/pro-trial", requireUser(), async c => c.json(await service.status(c.var.user.subject, c.req.param("slug"))))
    .get("/api/pro-trial/accounts", requireUser(), async c => c.json(await service.accounts(c.var.user.subject)))
    .get("/api/pro-trial/preview", requireUser(), async c => c.json(await service.preview(c.var.user.subject, c.req.query("accountKey") ?? "")))
    .post("/api/pro-trial/start", requireUser(), async c => {
      const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "trial-input-invalid", "试用请求无效，时长与商品版本由服务端配置决定");
      return c.json(await service.start({ ...parsed.data, subject: c.var.user.subject, subjectToken: c.var.user.rawToken, email: c.var.user.email ?? "" }));
    })
    .post("/api/ops/pro-trial/configuration", requirePlatformOperator("subscription.manage"), async c => {
      const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "trial-configuration-invalid", "试用配置无效");
      const v = parsed.data;
      const db = await getRootDatabaseSession("_system");
      await db.query(`BEGIN;
        LET $existing = (SELECT * FROM ONLY $id);
        IF $existing = NONE { CREATE $id CONTENT {
          product_revision: $product, duration_days: 7, research_rate: $rate, rate_revision: $rateRevision, reminder_hours: $hours, fixture: $fixture,
          approved_by: $subject, approval_reason: $reason
        }; } ELSE {
          IF $existing.product_revision != $product OR $existing.reminder_hours != $hours OR $existing.fixture != $fixture OR $existing.research_rate != $rate OR $existing.rate_revision != $rateRevision {
            THROW "trial-configuration-conflict";
          };
        };
        UPSERT pro_trial_configuration:current CONTENT { revision: $id, enabled: true, updated_by: $subject };
        COMMIT;`, { id: new RecordId("pro_trial_revision", v.revisionKey), product: new StringRecordId(v.productRevision),
          rate: v.researchRate, rateRevision: v.rateRevision, hours: v.reminderHours, fixture: v.fixture, reason: v.reason, subject: c.var.user.subject });
      return c.json({ revision: `pro_trial_revision:${v.revisionKey}` });
    })
    .post("/api/ops/pro-trial/eligibility", requirePlatformOperator("subscription.manage"), async c => {
      const parsed = eligibilitySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new HttpError(400, "trial-eligibility-invalid", "资格请求无效");
      const v = parsed.data;
      await (await getRootDatabaseSession("_system")).query(`
        LET $account = (SELECT id FROM billing_account WHERE account_key = $key AND status = "active" LIMIT 1)[0];
        IF $account = NONE { THROW "trial-account-missing"; };
        UPSERT type::record("pro_trial_eligibility", [$account.id]) CONTENT {
          billing_account: $account.id, enabled: $enabled, reason: $reason, approved_by: $subject
        };`, { key: v.accountKey, enabled: v.enabled, reason: v.reason, subject: c.var.user.subject });
      return c.json({ ok: true });
    });
}
