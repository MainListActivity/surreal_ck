import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import type { InternalScope } from "./context";
import type { Usage, Tariff } from "./pricing";
export type Queryable = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
export const GOAL = "2e2a6e41c1193595";
export const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify([GOAL, ...parts])).digest("hex");
function rows<T>(result: unknown): T[] { const first: unknown = Array.isArray(result) ? result[0] : undefined; return Array.isArray(first) ? first as T[] : first && typeof first === "object" ? [first as T] : []; }
export type Activity = { goal: string; enabled: boolean; total_limit: number; per_attempt_limit: number; attempt_limit: number; reserved: number; spent: number; attempts: number; approval_revision: string | null; evidence_expires_at: string | null; price_revisions: string[]; balance_nano_usd: number | null; balance_currency: string | null; balance_source: string | null; balance_sampled_at: string | null; balance_evidence_hash: string | null; auto_topup_disabled: boolean; service_approved: boolean };
export type Attempt = { id: RecordId; sequence: number; retry_index: number; state: string; reserved: number; cost: number | null; run_hash: string; key_hash: string; logical_hash: string; stage: string; provider: string; model: string; actual_model: string | null; request_id: string | null; usage: Usage | null; usage_source: string; price_revision: string; currency: string; started_at: unknown; ended_at: unknown };
export class InternalAiStore {
  constructor(private readonly db: () => Promise<Queryable>) {}
  async binding(subject: string, database: string): Promise<string | undefined> {
    const found = rows<{ activity: string }>(await (await this.db()).query("SELECT activity FROM internal_ai_binding WHERE identity_hash = $identity LIMIT 1", { identity: hash(subject, database) }));
    return found[0]?.activity;
  }
  async runActivity(subject: string, database: string, runId: string): Promise<string | undefined> {
    return rows<{ activity: string }>(await (await this.db()).query("SELECT activity FROM ONLY $run", { run: new RecordId("internal_ai_run", hash(subject, database, runId)) }))[0]?.activity;
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
          IF $a.goal != $goal OR $a.enabled != true OR $a.service_approved != true OR $a.auto_topup_disabled != true OR $a.approval_revision = NONE OR $a.balance_nano_usd = NONE OR $a.balance_nano_usd <= 0 OR $a.balance_currency != "USD" OR $a.balance_source = NONE OR $a.balance_evidence_hash = NONE OR string::len($a.balance_evidence_hash) != 64 OR $a.balance_source != "reviewed-document:" + $a.balance_evidence_hash OR $a.balance_sampled_at = NONE OR $a.evidence_expires_at = NONE OR <datetime>$a.evidence_expires_at <= time::now() OR $revision NOT IN $a.price_revisions { THROW "internal-ai-evidence-unavailable"; };
          IF $total.attempts >= 30 OR $total.spent + $total.reserved + $amount > 1000000000 { THROW "internal-ai-budget-exhausted"; };
          IF $amount > $a.per_attempt_limit OR $a.attempts >= $a.attempt_limit OR $a.spent + $a.reserved + $amount > $a.total_limit OR $total.spent + $total.reserved + $amount > $a.balance_nano_usd { THROW "internal-ai-budget-exhausted"; };
          UPDATE ONLY $target SET reserved += $amount, attempts += 1;
          UPDATE ONLY $activity SET reserved += $amount, attempts += 1;
          CREATE ONLY $attempt CONTENT { activity: $activity, sequence: $a.attempts + 1, retry_index: 0, run_hash: $run, key_hash: $key, logical_hash: $logical, stage: $stage, provider: $provider, model: $model, actual_model: NONE, request_id: NONE, reserved: $amount, cost: NONE, state: "reserved", usage: NONE, usage_source: "unknown", price_revision: $revision, currency: "USD", started_at: time::now(), ended_at: NONE };
          COMMIT TRANSACTION;`, { activity, attempt, target: new RecordId("internal_ai_target", GOAL), goal: GOAL, revision: tariff.revision, amount, run: scope.runHash, key: scope.keyHash, logical: scope.logicalHash, stage, provider: tariff.provider, model: tariff.model });
        void result;
        const found = rows<Attempt>(await db.query("SELECT * FROM ONLY $attempt", { attempt }))[0];
        if (!found) throw new Error("internal-ai-reservation-unconfirmed");
        return found;
      } catch (e) {
        if (retry < 8 && String(e).includes("can be retried")) continue;
        throw new Error(String(e).includes("budget-exhausted") ? "internal-ai-budget-exhausted" : "internal-ai-reservation-denied");
      }
    }
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
}
