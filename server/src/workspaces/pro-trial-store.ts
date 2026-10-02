import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { HttpError } from "../http-error";
import { toIsoDateTimeString } from "../db/surreal-values";
import { SurrealProductEntitlementStore } from "../product-entitlement/store";
import { stableSha256 } from "../quota/canonical";
import { AiAllowanceService, isRetryableTxnError } from "../ai-allowance/service";
import type { TrialClaim, TrialOffer, TrialStore } from "./pro-trial";

type Row = Record<string, unknown>;
type Db = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
const first = (v: unknown): Row | null => {
  const x = Array.isArray(v) ? v.at(-1) : v;
  const r = Array.isArray(x) ? x[0] : x;
  return r && typeof r === "object" ? r as Row : null;
};
const rows = (v: unknown): Row[] => Array.isArray(v) && Array.isArray(v[0]) ? v[0] as Row[] : [];
function requiredDate(v: unknown): string {
  const iso = toIsoDateTimeString(v);
  if (!iso) throw new Error("invalid trial clock");
  return iso;
}
function parseClaim(r: Row): TrialClaim {
  return { id: String(r.id), accountId: String(r.billing_account), subject: String(r.subject), slug: String(r.slug), name: String(r.name),
    startedAt: requiredDate(r.started_at), endsAt: requiredDate(r.ends_at), offer: r.offer as TrialOffer,
    state: r.state === "active" ? "active" : "provisioning" };
}

export const CLAIM_TRIAL_SQL = `
BEGIN;
LET $account = (SELECT id FROM billing_account WHERE account_key = $accountKey AND status = "active" LIMIT 1)[0];
LET $member = (SELECT id FROM billing_account_member WHERE billing_account = $account.id AND subject = $subject AND status = "active" AND role INSIDE ["owner", "admin"] LIMIT 1)[0];
LET $eligible = (SELECT id FROM pro_trial_eligibility WHERE billing_account = $account.id AND enabled = true LIMIT 1)[0];
LET $now = time::now();
LET $slot = type::record("pro_trial_slot", [$account.id]);
LET $claim = type::record("pro_trial_claim", $claimKey);
LET $old = (SELECT * FROM ONLY $claim);
LET $busyId = (SELECT current_claim FROM ONLY $slot).current_claim;
LET $busy = IF $busyId != NONE { SELECT * FROM ONLY $busyId } ELSE { NONE };
LET $existingTrial = (SELECT id FROM quota_subscription WHERE billing_account = $account.id AND status = "trialing" AND trial_start <= $now AND trial_end > $now LIMIT 1)[0];
LET $workspaceSlug = (SELECT id FROM workspace WHERE slug = $slug LIMIT 1)[0];
LET $otherSlug = (SELECT id FROM pro_trial_claim WHERE slug = $slug AND id != $claim LIMIT 1)[0];
LET $error = IF $account = NONE OR $member = NONE OR $eligible = NONE { "trial-forbidden" }
  ELSE IF $old = NONE AND (SELECT revision FROM ONLY pro_trial_configuration:current).revision != $offerId { "trial-offer-changed" }
  ELSE IF $old != NONE AND ($old.subject != $subject OR $old.slug != $slug OR $old.name != $name) { "trial-request-conflict" }
  ELSE IF $old != NONE AND $old.ends_at <= $now { "trial-expired" }
  ELSE IF $old = NONE AND $existingTrial != NONE { "trial-already-started" }
  ELSE IF $old = NONE AND $busy != NONE AND $busy.ends_at > $now { "trial-already-started" }
  ELSE IF $old = NONE AND $workspaceSlug != NONE { "trial-slug-conflict" }
  ELSE IF $otherSlug != NONE { "trial-request-conflict" } ELSE { NONE };
IF $error = NONE {
  IF $old = NONE {
    CREATE $claim CONTENT {
      billing_account: $account.id, subject: $subject, slug: $slug, name: $name,
      request_key: $requestKey, started_at: $now, ends_at: $now + 7d,
      offer: $offer, state: "provisioning"
    };
    UPSERT $slot CONTENT { billing_account: $account.id, current_claim: $claim };
  };
  LET $row = (SELECT * FROM ONLY $claim);
  IF $row.state != "active" AND ($row.lease_until = NONE OR $row.lease_until <= $now) {
    UPDATE $claim SET lease = $lease, lease_until = $now + 10m;
  };
};
RETURN { error: $error, claim: (SELECT * FROM ONLY $claim), acquired: (SELECT lease FROM ONLY $claim).lease = $lease };
COMMIT;
`;

/** 明确授权的 trial eligibility 不从 workspace admin 或 system_admin 推导。 */
export class SurrealTrialStore implements TrialStore {
  constructor(private readonly getDb: () => Promise<Db> = () => getRootDatabaseSession("_system")) {}

  async accounts(subject: string) {
    const db = await this.getDb();
    return rows(await db.query(`SELECT account_key AS key, name FROM billing_account
      WHERE status = "active" AND id IN (SELECT VALUE billing_account FROM billing_account_member
        WHERE subject = $subject AND status = "active" AND role INSIDE ["owner", "admin"])
      AND id IN (SELECT VALUE billing_account FROM pro_trial_eligibility WHERE enabled = true);`, { subject }))
      .map(r => ({ key: String(r.key), name: String(r.name) }));
  }

  async offer(subject: string, accountKey: string, requestKey?: string): Promise<TrialOffer> {
    const db = await this.getDb();
    const authorized = (await this.accounts(subject)).some(a => a.key === accountKey);
    if (!authorized) throw new HttpError(403, "trial-forbidden", "仅有资格的计费账户管理员可开始试用");
    // A retry must recover its approved immutable version even after the current
    // offer rolls forward. Current account role/eligibility is still rechecked.
    if (requestKey) {
      const claimId = new StringRecordId(`pro_trial_claim:${stableSha256(JSON.stringify([accountKey, requestKey]))}`);
      const existing = first(await db.query("SELECT * FROM ONLY $id;", { id: claimId }));
      if (existing) {
        if (existing.subject !== subject) throw new HttpError(403, "trial-forbidden", "原试用请求属于其他管理员");
        return parseClaim(existing).offer;
      }
    }
    const config = first(await db.query("SELECT * FROM ONLY pro_trial_configuration:current FETCH revision;"));
    const revision = config?.revision as Row | undefined;
    if (!revision || config?.enabled !== true) throw new HttpError(503, "trial-not-configured", "试用配置尚未获批启用");
    const productStore = new SurrealProductEntitlementStore(async () => db);
    const product = await productStore.productRevision(String(revision.product_revision));
    const rawProduct = first(await db.query("SELECT resource_template FROM ONLY $id;", { id: revision.product_revision }));
    const resource = first(await db.query("SELECT * FROM ONLY $id FETCH plan;", { id: rawProduct?.resource_template }));
    const allowance = product?.features.find(f => f.key === "ai_cycle_allowance" && f.enabled)?.limit;
    // 配置只引用获批不可变版本。禁止 export、机器/专业模块等额外 capability；不猜 AI 数值。
    if (!product || !resource || resource.template_kind !== "trial" || !allowance || !Number.isSafeInteger(allowance)
      || !Number.isSafeInteger(revision.research_rate) || Number(revision.research_rate) <= 0 || Number(revision.research_rate) > allowance
      || !Number.isSafeInteger(revision.rate_revision) || Number(revision.rate_revision) < 2
      || !product.collections.length || !["search", "read", "cite"].every(a => product.actions.includes(a))
      || product.actions.includes("export") || !product.aiActions.includes("research")
      || product.features.some(f => f.enabled && f.key !== "ai_cycle_allowance")) {
      throw new HttpError(503, "trial-configuration-invalid", "试用配置未满足核心研究范围与容量限制");
    }
    const rules = resource.rules as { customer_label: string; resource: string; selector: { kind: string; value: string }; limit: { kind: string; value?: number } }[];
    const managed = rules.filter(r => r.selector.kind === "regex" && r.selector.value === "^ent_");
    if (!["table", "field", "record"].every(resource => managed.some(r => r.resource === resource))
      || managed.some(r => r.limit.kind !== "finite" || !Number.isSafeInteger(r.limit.value))) {
      throw new HttpError(503, "trial-capacity-invalid", "试用必须使用获批有限业务容量");
    }
    return {
      revision: String(revision.id), productRevision: product.id, resourceRevision: String(resource.id),
      resourcePlanKey: String((resource.plan as Row).plan_key), collections: product.collections, allowance,
      researchRate: Number(revision.research_rate), rateRevision: Number(revision.rate_revision),
      capacity: managed.map(r => ({ label: r.customer_label, limit: r.limit.value! })),
      reminderHours: revision.reminder_hours as number[], fixture: revision.fixture === true,
    };
  }

  async claim(input: { subject: string; accountKey: string; name: string; slug: string; key: string; offerRevision: string }) {
    const db = await this.getDb();
    const offer = await this.offer(input.subject, input.accountKey, input.key);
    if (offer.revision !== input.offerRevision) throw new HttpError(409, "trial-offer-changed", "试用配置已变更，请重新核对范围");
    const claimKey = stableSha256(JSON.stringify([input.accountKey, input.key]));
    const lease = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await db.query(CLAIM_TRIAL_SQL, { ...input, accountKey: input.accountKey, requestKey: input.key, claimKey, offerId: new StringRecordId(offer.revision), offer, lease });
        // SDK transactions omit COMMIT results; find the explicit RETURN object.
        const resultRow = (Array.isArray(result) ? result : []).find(v => v && typeof v === "object" && "claim" in v) as { error?: string; claim: Row; acquired: boolean } | undefined;
        if (!resultRow) throw new Error("trial claim returned no result");
        if (resultRow.error) throw new HttpError(resultRow.error === "trial-forbidden" ? 403 : 409, resultRow.error, "试用资格或请求状态不允许此操作");
        return { claim: parseClaim(resultRow.claim), lease: resultRow.acquired ? lease : null };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const message = String(error);
        if (isRetryableTxnError(error) && attempt < 3) continue;
        for (const code of ["trial-forbidden", "trial-expired", "trial-already-started", "trial-request-conflict"]) {
          if (message.includes(code)) throw new HttpError(code === "trial-forbidden" ? 403 : 409, code, "试用资格或请求状态不允许此操作");
        }
        throw error;
      }
    }
  }

  async status(subject: string, slug: string) {
    const db = await this.getDb();
    const workspace = first(await db.query(`SELECT id, db_name FROM workspace WHERE slug = $slug
      AND id IN (SELECT VALUE workspace FROM user_workspace_index WHERE subject = $subject AND disabled_at = NONE) LIMIT 1;`, { subject, slug }));
    if (!workspace) throw new HttpError(404, "trial-workspace-not-found", "工作区不可访问");
    const claim = first(await db.query("SELECT * FROM pro_trial_claim WHERE slug = $slug ORDER BY created_at DESC LIMIT 1;", { slug }));
    if (!claim) return null;
    const parsed = parseClaim(claim);
    const store = new SurrealProductEntitlementStore(async () => db);
    const snapshot = await store.currentSnapshot(String(workspace.id));
    const remainingSeconds = Math.max(0, Math.floor((Date.parse(parsed.endsAt) - Date.now()) / 1000));
    const converted = snapshot?.baseSourceKind === "subscription";
    const state = converted ? "converted" : remainingSeconds === 0 ? "ended" : parsed.state;
    const allowances = new AiAllowanceService({ workspaceSession: async database => getRootDatabaseSession(database), systemSession: async () => db });
    const balance = await allowances.balance(String(workspace.db_name));
    return { state, remainingSeconds, startedAt: parsed.startedAt, endsAt: parsed.endsAt, allowance: balance.available,
      collections: parsed.offer.collections, fixture: parsed.offer.fixture,
      reminder: !converted && remainingSeconds > 0 && parsed.offer.reminderHours.some(h => remainingSeconds <= h * 3600),
      retention: "到期直接进入保留模式，自己的成果保留；全文和追问使用当前权限。新付费来源不继承旧试用余额。" };
  }

  async finish(claim: TrialClaim, lease: string, success: boolean) {
    const db = await this.getDb();
    await db.query(`UPDATE $claim SET state = $state, lease = NONE, lease_until = NONE
      WHERE lease = $lease;`, { claim: new StringRecordId(claim.id), lease, state: success ? "active" : "provisioning" });
  }
}
