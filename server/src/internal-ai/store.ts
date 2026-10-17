import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import { TOKEN_PLAN_PLAN_TYPE_FREE } from "@surreal-ck/shared";
import type { InternalScope } from "./context";
import type { Usage, Tariff } from "./pricing";
export type Queryable = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
/** reserve 拒绝的内部诊断类别：预算/证据/身份/持久化（含事务内引擎中止，如唯一索引冲突）。对外仍只报通用错误。 */
export type ReserveDenial = "budget" | "evidence" | "identity" | "persist";
export const MEASUREMENT_CYCLE = "d8763359-89a2-4296-8f5a-24fcb275766a";
export const MEASUREMENT_DATABASE = "ws_ddad14a98469";
export const MEASUREMENT_PRICE = "sensenova-token-plan-2026-10-10";
export type MeasurementCycle = { activity: string; attempts: number; attempt_limit: number; enabled_revision: number; approval_revision: string; evidence_hash: string; expires_at: string };
export const GOAL = "2e2a6e41c1193595";
export const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify([GOAL, ...parts])).digest("hex");
function rows<T>(result: unknown): T[] { const first: unknown = Array.isArray(result) ? result[0] : undefined; return Array.isArray(first) ? first as T[] : first && typeof first === "object" ? [first as T] : []; }
export type Activity = { goal: string; enabled: boolean; total_limit: number; per_attempt_limit: number; attempt_limit: number; reserved: number; spent: number; attempts: number; approval_revision: string | null; evidence_expires_at: string | null; price_revisions: string[]; balance_nano_usd: number | null; balance_currency: string | null; balance_source: string | null; balance_sampled_at: string | null; balance_evidence_hash: string | null; auto_topup_disabled: boolean; service_approved: boolean; evidence_kind?: string | null; plan_name?: string | null; plan_source_url?: string | null; quota_unit?: string | null; quota_amount?: number | null; quota_window_seconds?: number | null; quota_remaining?: number | null; no_payment_instrument?: boolean | null; account_plan_type?: string | null };
export type Attempt = { id: RecordId; measurement_cycle?: string; sequence: number; retry_index: number; state: string; reserved: number; cost: number | null; run_hash: string; key_hash: string; logical_hash: string; stage: string; provider: string; model: string; actual_model: string | null; request_id: string | null; usage: Usage | null; usage_source: string; price_revision: string; currency: string; started_at: unknown; ended_at: unknown };
/** 成本评价所需的 revision 证据投影字段（internal_ai_revision，FV06 只读）。 */
export type RevisionEvidenceRow = { revision: number; state: string; created_at: unknown; document_hash: string | null; evidence_kind: string | null; account_plan_type: string | null; account_ref: string | null; balance_sampled_at: unknown; evidence_expires_at: unknown; endpoint: string; model: string; price_revision: string };
export class InternalAiStore {
  constructor(private readonly db: () => Promise<Queryable>) {}
  async binding(subject: string, database: string): Promise<{ activity: string; revoked: boolean } | undefined> {
    const found = rows<{ activity: string; revoked: boolean }>(await (await this.db()).query("SELECT activity, revoked FROM internal_ai_binding WHERE identity_hash = $identity LIMIT 1", { identity: hash(subject, database) }));
    return found[0]?.activity === undefined ? undefined : { activity: found[0].activity, revoked: found[0].revoked === true };
  }
  /** 撤销是持久标记不是删除：被撤销身份的新旧run/key全部拒绝。 */
  async revoke(subject: string, database: string): Promise<void> {
    await (await this.db()).query("UPDATE internal_ai_binding SET revoked = true WHERE identity_hash = $identity", { identity: hash(subject, database) });
  }
  async runActivity(subject: string, database: string, runId: string): Promise<string | undefined> {
    return rows<{ activity: string }>(await (await this.db()).query("SELECT activity FROM ONLY $run", { run: new RecordId("internal_ai_run", hash(subject, database, runId)) }))[0]?.activity;
  }
  /** 曾参与内部活动的身份历史：binding 被删除后仍可核验，防止换run/key绕过。 */
  async identityActivity(subject: string, database: string): Promise<string | undefined> {
    return rows<{ activity: string }>(await (await this.db()).query("SELECT activity FROM internal_ai_run WHERE identity_hash = $identity LIMIT 1", { identity: hash(subject, database) }))[0]?.activity;
  }
  async scope(activity: string, subject: string, database: string, runId: string, key?: string): Promise<InternalScope> {
    const runHash = hash(subject, database, runId);
    const db = await this.db();
    const identity = hash(subject, database);
    const run = new RecordId("internal_ai_run", runHash);
    // run/key复用只关联持久身份；不得通过客户端改变活动。首次key由请求边界传入。
    if (key !== undefined) await db.query(`INSERT INTO internal_ai_run $row ON DUPLICATE KEY UPDATE run_hash = $row.run_hash;`, {
      row: { id: run, activity, identity_hash: identity, run_hash: runHash, key_hash: hash(subject, database, key), logical_hash: hash(subject, database, key) },
    });
    const row = rows<{ activity: string; identity_hash: string; key_hash: string; logical_hash: string }>(await db.query("SELECT activity, identity_hash, key_hash, logical_hash FROM ONLY $run", { run }))[0];
    if (!row || row.identity_hash !== identity || row.activity !== activity) throw new Error("internal-ai-run-unbound");
    return { activity, runHash, keyHash: row.key_hash, logicalHash: row.logical_hash };
  }
  async activity(id: string): Promise<Activity | undefined> { return rows<Activity>(await (await this.db()).query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_activity", id) }))[0]; }
  async target(): Promise<{ reserved: number; spent: number; attempts: number }> {
    return rows<{ reserved: number; spent: number; attempts: number }>(await (await this.db()).query("SELECT reserved, spent, attempts FROM ONLY $target", { target: new RecordId("internal_ai_target", GOAL) }))[0] ?? { reserved: 0, spent: 0, attempts: 0 };
  }
  async measurementCycle(): Promise<MeasurementCycle | undefined> {
    return rows<MeasurementCycle>(await (await this.db()).query("SELECT activity, attempts, attempt_limit, enabled_revision, approval_revision, evidence_hash, expires_at FROM ONLY $cycle", { cycle: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE) }))[0];
  }
  async reserve(scope: InternalScope, stage: string, tariff: Tariff, amount: number): Promise<Attempt> {
    const db = await this.db();
    const activity = new RecordId("internal_ai_activity", scope.activity);
    const attempt = new RecordId("internal_ai_attempt", crypto.randomUUID());
    // Conflict retries retry the DB transaction, never the provider. Unknown commit is conservative: no send.
    for (let retry = 0; ; retry++) {
      try {
        const result = await db.query(`BEGIN TRANSACTION;
          INSERT INTO internal_ai_target { id: $target } ON DUPLICATE KEY UPDATE attempts = attempts;
          LET $total = (SELECT * FROM ONLY $target);
          LET $a = (SELECT * FROM ONLY $activity);
          LET $cycle = (SELECT * FROM ONLY $cycleId);
          LET $measurement = $cycle != NONE AND $cycle.activity = $activityName;
          IF $measurement {
            IF $cycle.attempts >= $cycle.attempt_limit OR <datetime>$cycle.expires_at <= time::now() { THROW "internal-ai-budget-exhausted"; };
            LET $runIdentity = (SELECT identity_hash FROM internal_ai_run WHERE run_hash = $run LIMIT 1)[0];
            LET $bound = (SELECT * FROM internal_ai_binding WHERE identity_hash = $runIdentity.identity_hash LIMIT 1)[0];
            IF $bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName OR $bound.database != $measurementDatabase { THROW "internal-ai-binding-unavailable"; };
            IF $revision != $measurementPrice OR $model != "sensenova-6.8-flash-lite" OR $provider != "openai" OR $amount != 0 OR $a.evidence_kind != "reviewed-token-plan" OR $a.balance_evidence_hash != $cycle.evidence_hash OR $a.approval_revision != $cycle.approval_revision { THROW "internal-ai-evidence-unavailable"; };
          };
          IF $a.goal != $goal OR $a.enabled != true OR $a.service_approved != true OR $a.auto_topup_disabled != true OR $a.approval_revision = NONE OR $a.balance_evidence_hash = NONE OR string::len($a.balance_evidence_hash) != 64 OR $a.balance_source = NONE OR $a.balance_sampled_at = NONE OR $a.evidence_expires_at = NONE OR <datetime>$a.evidence_expires_at <= time::now() OR $revision NOT IN $a.price_revisions { THROW "internal-ai-evidence-unavailable"; };
          IF $a.evidence_kind = "reviewed-token-plan" {
            IF $a.plan_name = NONE OR string::len($a.plan_name) = 0 OR $a.plan_source_url = NONE OR $a.quota_unit = NONE OR $a.quota_amount = NONE OR $a.quota_amount <= 0 OR $a.quota_window_seconds = NONE OR ($a.quota_remaining != NONE AND $a.quota_remaining <= 0) OR $a.account_plan_type != $tokenPlanFree OR $a.balance_nano_usd != NONE OR $a.balance_currency != NONE OR $a.balance_source != "token-plan:" + $a.balance_evidence_hash OR $amount != 0 { THROW "internal-ai-evidence-unavailable"; };
          } ELSE {
            IF $a.balance_nano_usd = NONE OR $a.balance_nano_usd <= 0 OR $a.balance_currency != "USD" OR $a.balance_source != "reviewed-document:" + $a.balance_evidence_hash { THROW "internal-ai-evidence-unavailable"; };
          };
          // def-capability-300s-fragility：用户门禁锚定受审账本，不锚定操作者投递会话。
          // 投递 proof 自身 ≤300s 且公司状态有效性绑定投递租约（公司侧 valid() 在 proof 过期后必回 valid=false），
          // 把 attempt 绑在该会话上会让已启用活动在 >300s 后全部拒绝、须人工整链重刷。
          // 因此这里只复核持久 fail-closed 状态：绑定存在、未撤销、归属本活动；撤销/删除式撤权仍立即拒绝。
          IF $a.registration_jti != NONE {
            LET $runBinding = (SELECT identity_hash FROM internal_ai_run WHERE run_hash = $run LIMIT 1)[0];
            LET $binding = (SELECT * FROM internal_ai_binding WHERE identity_hash = $runBinding.identity_hash LIMIT 1)[0];
            IF $binding = NONE OR $binding.revoked = true OR $binding.activity != $activityName { THROW "internal-ai-binding-unavailable"; };
          };
          IF ($measurement = false AND $total.attempts >= 30) OR $total.spent + $total.reserved + $amount > 1000000000 { THROW "internal-ai-budget-exhausted"; };
          IF $amount > $a.per_attempt_limit OR ($measurement = false AND $a.attempts >= $a.attempt_limit) OR $a.spent + $a.reserved + $amount > $a.total_limit OR ($a.evidence_kind != "reviewed-token-plan" AND $total.spent + $total.reserved + $amount > $a.balance_nano_usd) { THROW "internal-ai-budget-exhausted"; };
          IF $measurement {
            UPDATE ONLY $cycleId SET attempts += 1;
          } ELSE {
            UPDATE ONLY $target SET reserved += $amount, attempts += 1;
            UPDATE ONLY $activity SET reserved += $amount, attempts += 1;
          };
          // measurement 模式下 sequence 延续该活动全部历史账本：周期轮换重置 cycle.attempts，
          // 基于它派生会撞 internal_ai_sequence (activity, sequence) 唯一索引；现金路径保持 a.attempts+1 不变。
          // 子查询只在 measurement 分支求值（IF 惰性），并发由上行 cycle/activity 写冲突串行化重试。
          CREATE ONLY $attempt CONTENT { activity: $activity, sequence: IF $measurement { ((SELECT sequence FROM internal_ai_attempt WHERE activity = $activity ORDER BY sequence DESC LIMIT 1)[0].sequence ?? 0) + 1 } ELSE { $a.attempts + 1 }, measurement_cycle: IF $measurement { $cycleName } ELSE { NONE }, retry_index: 0, run_hash: $run, key_hash: $key, logical_hash: $logical, stage: $stage, provider: $provider, model: $model, actual_model: NONE, request_id: NONE, reserved: $amount, cost: NONE, state: "reserved", usage: NONE, usage_source: "unknown", price_revision: $revision, currency: "USD", started_at: time::now(), ended_at: NONE };
          COMMIT TRANSACTION;`, { activity, activityName: scope.activity, cycleId: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), cycleName: MEASUREMENT_CYCLE, measurementPrice: MEASUREMENT_PRICE, measurementDatabase: MEASUREMENT_DATABASE, attempt, target: new RecordId("internal_ai_target", GOAL), goal: GOAL, revision: tariff.revision, amount, run: scope.runHash, key: scope.keyHash, logical: scope.logicalHash, stage, provider: tariff.provider, model: tariff.model, tokenPlanFree: TOKEN_PLAN_PLAN_TYPE_FREE });
        void result;
        const found = rows<Attempt>(await db.query("SELECT * FROM ONLY $attempt", { attempt }))[0];
        if (!found) throw new Error("internal-ai-reservation-unconfirmed");
        return found;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (retry < 8 && raw.includes("can be retried")) continue;
        if (raw.includes("budget-exhausted")) throw new Error("internal-ai-budget-exhausted");
        const reason = await this.reserveDenial(scope, tariff, amount, raw);
        // 门禁全过的引擎中止（唯一索引/序列化失败）从未提交：执行期失败可安全重试，
        // 不会像 unknown-commit 那样重复留账；门禁拒绝与读回型异常仍不重试。
        if (reason === "persist" && retry < 4 && raw.includes("failed transaction")) continue;
        console.warn("[internal-ai] reserve denied", { reason, activity: scope.activity, stage });
        throw new Error(reason === "budget" ? "internal-ai-budget-exhausted" : "internal-ai-reservation-denied");
      }
    }
  }
  /**
   * 只读复核 reserve 同一组门禁，把 generic 事务中止归类到预算/证据/身份/持久化。
   * 本 fork 里事务内一旦执行过任何语句，后续 THROW 的标记也被折叠成 "failed transaction"
   * （标记透出仅作防御性快路径），因此按事务评估顺序重放各条件定位真实拦截点。
   * 只输出布尔与计数投影，不读客户正文、不返回任何行内容。
   */
  private async reserveDenial(scope: InternalScope, tariff: Tariff, amount: number, raw: string): Promise<ReserveDenial> {
    if (raw.includes("internal-ai-binding-unavailable")) return "identity";
    if (raw.includes("internal-ai-evidence-unavailable")) return "evidence";
    try {
      // db.query 返回按语句排列的结果数组：各 LET 占 null 位，RETURN 的对象在末位。
      const result = await (await this.db()).query(`
        LET $total = (SELECT * FROM ONLY $target);
        LET $a = (SELECT * FROM ONLY $activity);
        LET $cycle = (SELECT * FROM ONLY $cycleId);
        LET $measurement = $cycle != NONE AND $cycle.activity = $activityName;
        LET $runIdentity = (SELECT identity_hash FROM internal_ai_run WHERE run_hash = $run LIMIT 1)[0];
        LET $bound = (SELECT * FROM internal_ai_binding WHERE identity_hash = $runIdentity.identity_hash LIMIT 1)[0];
        RETURN {
          cycleBudget: $measurement AND ($cycle.attempts >= $cycle.attempt_limit OR <datetime>$cycle.expires_at <= time::now()),
          binding: $measurement AND ($bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName OR $bound.database != $measurementDatabase),
          measurementEvidence: $measurement AND ($revision != $measurementPrice OR $model != "sensenova-6.8-flash-lite" OR $provider != "openai" OR $amount != 0
            OR $a.evidence_kind != "reviewed-token-plan" OR $a.balance_evidence_hash != $cycle.evidence_hash OR $a.approval_revision != $cycle.approval_revision),
          evidence: $a.goal != $goal OR $a.enabled != true OR $a.service_approved != true OR $a.auto_topup_disabled != true OR $a.approval_revision = NONE
            OR $a.balance_evidence_hash = NONE OR string::len($a.balance_evidence_hash) != 64 OR $a.balance_source = NONE OR $a.balance_sampled_at = NONE
            OR $a.evidence_expires_at = NONE OR <datetime>$a.evidence_expires_at <= time::now() OR $revision NOT IN $a.price_revisions
            OR (IF $a.evidence_kind = "reviewed-token-plan" { $a.plan_name = NONE OR string::len($a.plan_name) = 0 OR $a.plan_source_url = NONE OR $a.quota_unit = NONE OR $a.quota_amount = NONE OR $a.quota_amount <= 0 OR $a.quota_window_seconds = NONE OR ($a.quota_remaining != NONE AND $a.quota_remaining <= 0) OR $a.account_plan_type != $tokenPlanFree OR $a.balance_nano_usd != NONE OR $a.balance_currency != NONE OR $a.balance_source != "token-plan:" + $a.balance_evidence_hash OR $amount != 0 } ELSE { $a.balance_nano_usd = NONE OR $a.balance_nano_usd <= 0 OR $a.balance_currency != "USD" OR $a.balance_source != "reviewed-document:" + $a.balance_evidence_hash }),
          registeredBinding: $a.registration_jti != NONE AND ($bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName),
          budget: ($measurement = false AND $total != NONE AND $total.attempts >= 30) OR ($total.spent ?? 0) + ($total.reserved ?? 0) + $amount > 1000000000
            OR ($a.per_attempt_limit != NONE AND $amount > $a.per_attempt_limit) OR ($measurement = false AND $a.attempt_limit != NONE AND $a.attempts != NONE AND $a.attempts >= $a.attempt_limit) OR ($a.total_limit != NONE AND ($a.spent ?? 0) + ($a.reserved ?? 0) + $amount > $a.total_limit)
            OR ($a.evidence_kind != "reviewed-token-plan" AND ($total.spent ?? 0) + ($total.reserved ?? 0) + $amount > ($a.balance_nano_usd ?? 0)),
          ledgerMax: (SELECT sequence FROM internal_ai_attempt WHERE activity = $activity ORDER BY sequence DESC LIMIT 1)[0].sequence
        };`, { activity: new RecordId("internal_ai_activity", scope.activity), activityName: scope.activity, cycleId: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), measurementPrice: MEASUREMENT_PRICE, measurementDatabase: MEASUREMENT_DATABASE, target: new RecordId("internal_ai_target", GOAL), goal: GOAL, revision: tariff.revision, amount, run: scope.runHash, provider: tariff.provider, model: tariff.model, tokenPlanFree: TOKEN_PLAN_PLAN_TYPE_FREE });
      const gates = (Array.isArray(result) ? result.at(-1) : result) as { cycleBudget: boolean; binding: boolean; measurementEvidence: boolean; evidence: boolean; registeredBinding: boolean; budget: boolean; ledgerMax: number | null } | undefined;
      // 与事务内门禁评估顺序一致：周期预算 → 测量绑定 → 测量证据 → 活动证据 → 登记绑定 → 目标/活动预算。
      if (gates?.cycleBudget) return "budget";
      if (gates?.binding) return "identity";
      if (gates?.measurementEvidence || gates?.evidence) return "evidence";
      if (gates?.registeredBinding) return "identity";
      if (gates?.budget) return "budget";
      return "persist";
    } catch (probeErr) { console.warn("[internal-ai] denial probe failed", { error: probeErr instanceof Error ? probeErr.name : "unknown" }); return "persist"; }
  }
  async sent(id: RecordId): Promise<void> {
    const result = rows<Attempt>(await (await this.db()).query('UPDATE ONLY $id SET state = "sent" WHERE state = "reserved" RETURN AFTER', { id }));
    if (result.length !== 1) throw new Error("internal-ai-attempt-replayed");
  }
  async finish(id: RecordId, input: { usage: Usage | null; actualModel: string | null; requestId: string | null; cost: number | null; failed: boolean }): Promise<void> {
    const db = await this.db();
    for (let retry = 0; ; retry++) {
      try {
        await db.query(`BEGIN TRANSACTION;
          LET $r = (SELECT * FROM ONLY $id);
          IF $r.state = "sent" {
            IF $cost != NONE AND $cost != NULL AND $cost <= $r.reserved AND $failed = false {
              UPDATE ONLY $target SET reserved -= $r.reserved, spent += $cost;
              UPDATE ONLY $r.activity SET reserved -= $r.reserved, spent += $cost;
              UPDATE ONLY $id SET state = "settled", cost = $cost;
            } ELSE { UPDATE ONLY $id SET state = "uncertain"; };
            UPDATE ONLY $id SET usage = IF $usage = NULL { NONE } ELSE { $usage }, actual_model = IF $model = NULL { NONE } ELSE { $model }, request_id = IF $request = NULL { NONE } ELSE { $request }, usage_source = IF $usage = NONE OR $usage = NULL { "unknown" } ELSE { "provider" }, ended_at = time::now();
          };
          COMMIT TRANSACTION;`, { id, target: new RecordId("internal_ai_target", GOAL), usage: input.usage, model: input.actualModel, request: input.requestId, cost: input.cost, failed: input.failed });
        return;
      } catch (e) { if (retry < 8 && String(e).includes("can be retried")) continue; throw new Error("internal-ai-settlement-unavailable"); }
    }
  }
  async page(activity: string, after = 0): Promise<Attempt[]> {
    return rows<Attempt>(await (await this.db()).query("SELECT * FROM internal_ai_attempt WHERE activity = $activity AND sequence > $after ORDER BY sequence LIMIT 50", { activity: new RecordId("internal_ai_activity", activity), after }));
  }
  /** FV06 只读投影：评价所需的授权 revision 字段，绝不读 operator/identity 明细。 */
  async revisionEvidence(activity: string): Promise<RevisionEvidenceRow[]> {
    // internal_ai_revision.activity 是 TYPE string（035 schema）；记录链接绑定恒不匹配。
    return rows<RevisionEvidenceRow>(await (await this.db()).query("SELECT revision, state, created_at, document_hash, evidence_kind, account_plan_type, account_ref, balance_sampled_at, evidence_expires_at, endpoint, model, price_revision FROM internal_ai_revision WHERE activity = $activity ORDER BY revision", { activity }));
  }
}
