import { RecordId, StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { ProductEntitlementService } from "../product-entitlement/service";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { AiAllowancePlanCycleSynchronizer } from "../ai-allowance/plan-cycle";
import { getContentProjectionSession } from "../content/reader-session";
import { fetchContentReaderTarget, writeContentReaderProjection } from "../content/reader-projection";
import { planContentReaderExchange } from "../content/reader-exchange";
import { CONTENT_CATALOG_SCAN_QUERY } from "../content/search-exchange";
import { env } from "../env";
import { toIsoDateTimeString } from "../db/surreal-values";
import type { ContentProjectionClient } from "../content/reader-session";
import type { ExplicitResourceSource } from "./provisioning-saga";

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => Array.isArray(v) && Array.isArray(v[0]) ? v[0] as Row[] : [];

/** activate 前的控制面交付。仅声明来源的 creator 可调用；无业务正文读取、无用户 token。 */
export function createProTrialDelivery(deps: {
  session?: (database: string, namespace?: string) => Promise<{ query(sql: string, vars?: Record<string, unknown>): Promise<unknown> }>;
  content?: () => Promise<ContentProjectionClient>;
} = {}) {
  const session = deps.session ?? getRootDatabaseSession;
  const getContent = deps.content ?? getContentProjectionSession;
  return async (input: { workspaceId: string; dbName: string; subject: string; trial: NonNullable<ExplicitResourceSource["trial"]> }) => {
  if (Date.parse(input.trial.endsAt) <= Date.now()) throw new Error("trial-expired");
  const store = new SurrealProductEntitlementStore(session);
  const products = new ProductEntitlementService(store);
  const { planCycle } = await products.refreshSubscriptionDriven(input.workspaceId, { correlationId: input.trial.claimId });
  if (!planCycle || planCycle.baseSourceKind !== "trial" || planCycle.expiresAt !== input.trial.endsAt) throw new Error("trial-product-not-ready");
  const db = await session(input.dbName);
  await db.query(`INSERT INTO ai_rate_card {
    id: $id, action_key: "research", revision: $revision, amount: $amount,
    revision_label: $label, tier_label: "Pro 试用研究", status: "active"
  } ON DUPLICATE KEY UPDATE status = status;`, {
    id: new RecordId("ai_rate_card", `pro_trial_${input.trial.rateRevision}`), revision: input.trial.rateRevision,
    amount: input.trial.researchRate, label: input.trial.fixture ? "approved-trial-fixture" : "approved-pro-trial",
  });
  const rate = rows(await db.query('SELECT amount, revision FROM ai_rate_card WHERE action_key = "research" AND status = "active" ORDER BY revision DESC LIMIT 1;'))[0];
  if (rate?.amount !== input.trial.researchRate || rate.revision !== input.trial.rateRevision) throw new Error("trial-rate-readback-failed");
  await new AiAllowancePlanCycleSynchronizer({ workspaceSession: async () => db }).sync(planCycle, input.trial.claimId);
  const bucket = rows(await db.query("SELECT total, expires_at FROM ai_allowance_bucket WHERE period_key = $period AND upgrade_event_key = NONE;", { period: planCycle.periodKey }))[0];
  if (!bucket || bucket.total !== planCycle.cycleAllowance) throw new Error("trial-allowance-readback-failed");
  const snapshot = await store.currentSnapshot(input.workspaceId);
  if (!snapshot || snapshot.productPlanRevisionId !== input.trial.productRevisionId) throw new Error("trial-snapshot-mismatch");
  const content = await getContent();
  const catalog = rows(await content.query(CONTENT_CATALOG_SCAN_QUERY));
  if (catalog.length > 5000) throw new Error("trial-content-catalog-too-large");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const matched = new Set<string>();
  const plans = [];
  for (const row of catalog) {
    if (typeof row.public_id !== "string") throw new Error("trial-content-pointer-missing");
    const target = await fetchContentReaderTarget(content, row.public_id);
    const planned = planContentReaderExchange({ body: { contentPublicId: row.public_id }, subject: input.subject,
      workspaceDb: input.dbName, workspaceActive: true, membership: "active", activeSubjects: [input.subject],
      nowSeconds, subjectExpiresAtSeconds: nowSeconds + 900, subjectIsContentReader: false,
      database: env.CONTENT_DATABASE, namespace: env.SURREAL_NS,
      entitlement: { revision: snapshot.revision, digest: snapshot.digest, resolverVersion: snapshot.resolverVersion,
        effectiveUntilSeconds: Math.floor(Date.parse(input.trial.endsAt) / 1000), collections: snapshot.collections.map(c => c.key),
        contentActions: snapshot.actions, aiActions: snapshot.aiActions }, content: target,
    });
    if (planned.ok && ["search", "read", "cite"].every(a => planned.plan.write.gateActions.includes(a))
      && planned.plan.write.gateAiActions.includes("research")) {
      plans.push(planned.plan);
      for (const key of target?.collectionKeys ?? []) matched.add(key);
    }
  }
  if (!snapshot.collections.every(c => matched.has(c.key))) throw new Error("trial-content-license-not-ready");
  for (const plan of plans) await writeContentReaderProjection(content, plan.write);
  const projection = rows(await content.query("SELECT digest, status FROM $id;", { id: new RecordId("content_authorization_projection", [input.dbName]) }))[0];
  if (projection?.digest !== snapshot.digest || projection.status !== "active") throw new Error("trial-content-readback-failed");
  const system = await session("_system");
  const claim = rows(await system.query("SELECT lease, lease_until, ends_at FROM $id;", { id: new StringRecordId(input.trial.claimId) }))[0];
  if (claim?.lease !== input.trial.leaseId || !toIsoDateTimeString(claim.lease_until) || Date.parse(toIsoDateTimeString(claim.lease_until)!) <= Date.now()) throw new Error("trial-provisioning-fence-lost");
  const rights = rows(await system.query(`SELECT id FROM billing_account_member WHERE billing_account = $account AND subject = $subject AND status = "active" AND role INSIDE ["owner", "admin"]
    AND billing_account.status = "active" AND billing_account IN (SELECT VALUE billing_account FROM pro_trial_eligibility WHERE enabled = true);`, { account: new StringRecordId(input.trial.billingAccountId), subject: input.subject }));
  if (!rights.length) throw new Error("trial-billing-authority-revoked");
  if (Date.parse(input.trial.endsAt) <= Date.now()) throw new Error("trial-expired");
  };
}

export const deliverProTrial = createProTrialDelivery();
