import { createHash } from "node:crypto";
import { RecordId } from "surrealdb";
import { TOKEN_PLAN_PLAN_TYPE_FREE, MAGPIE_B_ENVELOPE, type MagpieWindowCreate } from "@surreal-ck/shared";
import type { InternalScope } from "./context";
import type { Usage, Tariff } from "./pricing";
import { payloadHash, validateWindowCreate, WindowDenied, type WindowRow } from "./window";
export type Queryable = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
/** reserve 拒绝的内部诊断类别：预算/证据/身份/持久化（含事务内引擎中止，如唯一索引冲突）。对外仍只报通用错误。 */
export type ReserveDenial = "budget" | "evidence" | "identity" | "persist";
export const MEASUREMENT_CYCLE = "a7537d2c-3b76-42b3-bfb8-459956340984";
export const MEASUREMENT_DATABASE = "ws_ddad14a98469";
export const MEASUREMENT_PRICE = "sensenova-token-plan-2026-10-10";
export type MeasurementCycle = { activity: string; attempts: number; attempt_limit: number; enabled_revision: number; approval_revision: string; evidence_hash: string; expires_at: string };
export const GOAL = "2e2a6e41c1193595";
export const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify([GOAL, ...parts])).digest("hex");
function rows<T>(result: unknown): T[] { const first: unknown = Array.isArray(result) ? result[0] : undefined; return Array.isArray(first) ? first as T[] : first && typeof first === "object" ? [first as T] : []; }
export type Activity = { goal: string; enabled: boolean; total_limit: number; per_attempt_limit: number; attempt_limit: number; reserved: number; spent: number; attempts: number; approval_revision: string | null; evidence_expires_at: string | null; price_revisions: string[]; balance_nano_usd: number | null; balance_currency: string | null; balance_source: string | null; balance_sampled_at: string | null; balance_evidence_hash: string | null; auto_topup_disabled: boolean; service_approved: boolean; evidence_kind?: string | null; plan_name?: string | null; plan_source_url?: string | null; quota_unit?: string | null; quota_amount?: number | null; quota_window_seconds?: number | null; quota_remaining?: number | null; no_payment_instrument?: boolean | null; account_plan_type?: string | null; window_id?: RecordId | null; window_revision?: number };
export type Attempt = { id: RecordId; measurement_cycle?: string; window?: RecordId | null; sequence: number; retry_index: number; state: string; reserved: number; cost: number | null; run_hash: string; key_hash: string; logical_hash: string; stage: string; provider: string; model: string; actual_model: string | null; requested_model?: string | null; served_model?: string | null; route_revision?: string | null; route_digest?: string | null; account_binding?: string | null; usage_raw?: Record<string, unknown> | null; cost_status?: string | null; amortized_cost_nano_usd?: number | null; marginal_cost_nano_usd?: number | null; price_basis?: string | null; failure_class?: string | null; route_drift?: boolean; request_id: string | null; usage: Usage | null; usage_source: string; price_revision: string; currency: string; started_at: unknown; ended_at: unknown };
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
  async envelopeSummary(): Promise<{ id: string; goal: string; maxAttempts: number; totalNanoUsd: number; perAttemptNanoUsd: number; expiresAt: string; approvalRefs: readonly string[]; usedAttempts: number; committedAttempts: number; remainingAttempts: number; committedNanoUsd: number; spentNanoUsd: number; reservedNanoUsd: number; remainingNanoUsd: number } | undefined> {
    const db = await this.db();
    const row = rows<{ goal: string; max_attempts: number; total_nano_usd: number; per_attempt_nano_usd: number; expires_at: string; approval_refs: readonly string[]; attempts: number; allocated_nano_usd: number; reserved: number; spent: number }>(await db.query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id) }))[0];
    if (!row || row.goal !== MAGPIE_B_ENVELOPE.goal || row.max_attempts !== MAGPIE_B_ENVELOPE.maxAttempts || row.total_nano_usd !== MAGPIE_B_ENVELOPE.totalNanoUsd || row.per_attempt_nano_usd !== MAGPIE_B_ENVELOPE.perAttemptNanoUsd || row.expires_at !== MAGPIE_B_ENVELOPE.expiresAt || row.approval_refs.join(",") !== MAGPIE_B_ENVELOPE.approvalRefs.join(",")) return undefined;
    const committed = rows<{ attempts: number; nano_usd: number }>(await db.query(`SELECT math::sum(attempt_limit - attempts) AS attempts, math::sum(source_budget_nano_usd - spent - reserved) AS nano_usd FROM internal_ai_window WHERE envelope = $envelope AND status = "active" AND <datetime>evidence_expires_at > time::now() GROUP ALL`, { envelope: MAGPIE_B_ENVELOPE.id }))[0];
    const usedRows = await db.query("SELECT count() FROM internal_ai_attempt WHERE envelope = $envelope GROUP ALL", { envelope: MAGPIE_B_ENVELOPE.id });
    const usedAttempts = Number(rows<{ count: number }>(usedRows)[0]?.count ?? 0);
    const committedAttempts = Number(committed?.attempts ?? 0);
    const committedNanoUsd = Number(committed?.nano_usd ?? 0);
    if (usedAttempts !== row.attempts) return undefined;
    return { id: MAGPIE_B_ENVELOPE.id, goal: row.goal, maxAttempts: row.max_attempts, totalNanoUsd: row.total_nano_usd, perAttemptNanoUsd: row.per_attempt_nano_usd, expiresAt: row.expires_at, approvalRefs: row.approval_refs, usedAttempts, committedAttempts, remainingAttempts: Math.max(0, row.max_attempts - usedAttempts - committedAttempts), committedNanoUsd, spentNanoUsd: row.spent, reservedNanoUsd: row.reserved, remainingNanoUsd: Math.max(0, row.total_nano_usd - row.allocated_nano_usd) };
  }
  async window(id: string): Promise<WindowRow | undefined> {
    return rows<WindowRow>(await (await this.db()).query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_window", id) }))[0];
  }
  /** 活动当前绑定的窗口（可能已过期/耗尽，交由调用方判定；不自动回退旧价目）。 */
  async boundWindow(activity: string): Promise<WindowRow | undefined> {
    const row = await this.activity(activity);
    const bound = row?.window_id;
    if (!bound) return undefined;
    return this.window(String(bound.id));
  }
  /** 活动窗口 CAS 版本：ops 创建/绑定都用它做读写串行化。 */
  async windowRevision(activity: string): Promise<number> {
    return (await this.activity(activity))?.window_revision ?? 0;
  }
  /**
   * 新受控窗口创建：代码侧先做旧证据/容量/路由/剩余次数校验，事务内再用活动写锁
   * 串行化「全部历史 attempt 数 + 现有 active 窗口承诺次数」，杜绝并发重复领取。
   * 幂等键相同且载荷一致返回既有窗口；批准摘要重复一律拒绝。
   */
  async createWindow(input: MagpieWindowCreate, operator: string): Promise<{ window: WindowRow; idempotentReplay: boolean }> {
    const db = await this.db();
    const activityId = new RecordId("internal_ai_activity", input.activity);
    const row = new RecordId("internal_ai_window", crypto.randomUUID());
    const digest = payloadHash(input);
    const activityRow = await this.activity(input.activity);
    if (!activityRow) throw new WindowDenied("magpie-window-activity-unknown", "活动尚未受审配置");
    // 幂等优先：重放同一幂等键与同一载荷必须返回既有窗口，不能被「剩余次数已被该窗口占用」再次拒绝。
    const existing = rows<WindowRow>(await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity AND idempotency_key = $idem LIMIT 1", { activity: input.activity, idem: input.idempotencyKey }))[0];
    if (existing) {
      if (existing.payload_hash !== digest) throw new WindowDenied("magpie-window-idempotency-conflict", "同一幂等键的载荷不一致");
      return { window: existing, idempotentReplay: true };
    }
    // 批准摘要重复优先于剩余次数：同一批准不能因预算变化被误报成「次数不足」。
    const consumedApproval = rows<WindowRow>(await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity AND approval_digest = $approval LIMIT 1", { activity: input.activity, approval: input.approvalDigest }))[0];
    if (consumedApproval) throw new WindowDenied("magpie-window-approval-consumed", "该批准摘要已创建过窗口");
    const envelopeRecord = new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id);
    let verifiedEnvelope = input.envelope === MAGPIE_B_ENVELOPE.id ? await this.envelopeSummary() : undefined;
    if (input.envelope === MAGPIE_B_ENVELOPE.id && !verifiedEnvelope) {
      const exists = rows<Record<string, unknown>>(await db.query("SELECT * FROM ONLY $id", { id: envelopeRecord }))[0];
      if (exists) throw new WindowDenied("magpie-window-envelope-invalid", "B 档包络账本与批准摘要不一致");
      await db.query(`INSERT INTO internal_ai_envelope { id: $id, goal: $goal, max_attempts: $max, total_nano_usd: $total, per_attempt_nano_usd: $per, expires_at: $expires, approval_refs: $approvals, attempts: 0, committed_attempts: 0, allocated_nano_usd: 0, reserved: 0, spent: 0, revision: 0 } ON DUPLICATE KEY UPDATE goal = goal;`, {
        id: envelopeRecord, goal: MAGPIE_B_ENVELOPE.goal, max: MAGPIE_B_ENVELOPE.maxAttempts, total: MAGPIE_B_ENVELOPE.totalNanoUsd,
        per: MAGPIE_B_ENVELOPE.perAttemptNanoUsd, expires: MAGPIE_B_ENVELOPE.expiresAt, approvals: [...MAGPIE_B_ENVELOPE.approvalRefs],
      });
      verifiedEnvelope = await this.envelopeSummary();
    }
    if (input.envelope === MAGPIE_B_ENVELOPE.id && !verifiedEnvelope) throw new WindowDenied("magpie-window-envelope-invalid", "B 档包络账本不可用");
    // 预读只用于把明确拒绝在事务外说清楚；事务内仍以锁后读数为准。
    const [usedRows, committedRows, target, cycle] = await Promise.all([
      db.query("SELECT count() FROM internal_ai_attempt WHERE envelope = NONE GROUP ALL", {}),
      db.query('SELECT math::sum(attempt_limit - attempts) FROM internal_ai_window WHERE envelope = NONE AND activity = $activity AND status = "active" AND <datetime>evidence_expires_at > time::now() GROUP ALL', { activity: input.activity }),
      this.target(),
      this.measurementCycle(),
    ]);
    const countedAttempts = Number((rows<{ count: number }>(usedRows)[0]?.count ?? 0));
    const totalUsed = Math.max(countedAttempts, (target.attempts ?? 0) + (cycle?.attempts ?? 0));
    const committedAttempts = Number(rows<Record<string, number>>(committedRows)[0]?.['math::sum'] ?? 0);
    validateWindowCreate(input, {
      totalUsed, committedAttempts, activityTotalLimit: activityRow.total_limit, activityPerAttemptLimit: activityRow.per_attempt_limit,
      envelopeUsed: verifiedEnvelope?.usedAttempts, envelopeCommitted: verifiedEnvelope?.committedAttempts,
      envelopeCommittedNanoUsd: verifiedEnvelope?.committedNanoUsd, envelopeSpentNanoUsd: verifiedEnvelope?.spentNanoUsd, envelopeReservedNanoUsd: verifiedEnvelope?.reservedNanoUsd,
    });
    for (let retry = 0; ; retry++) {
      try {
        await db.query(`BEGIN TRANSACTION;
          IF $isEnvelope { UPDATE ONLY $envelopeId SET revision += 1; };
          UPDATE ONLY $activityId SET window_revision = (window_revision ?? 0) + 1;
          LET $a = (SELECT * FROM ONLY $activityId);
          IF $a = NONE { THROW "magpie-window-activity-unknown"; };
          LET $envelope = IF $isEnvelope { (SELECT * FROM ONLY $envelopeId) } ELSE { NONE };
          LET $existingKey = (SELECT * FROM internal_ai_window WHERE activity = $activityName AND idempotency_key = $idem LIMIT 1)[0];
          LET $existingApproval = (SELECT * FROM internal_ai_window WHERE activity = $activityName AND approval_digest = $approval LIMIT 1)[0];
          LET $target = (SELECT * FROM $targetId)[0];
          LET $cycle = (SELECT * FROM $cycleId)[0];
          LET $count = (SELECT count() FROM internal_ai_attempt WHERE envelope = NONE GROUP ALL)[0].count ?? 0;
          LET $counter = (IF $target = NONE { 0 } ELSE { $target.attempts }) + (IF $cycle = NONE { 0 } ELSE { $cycle.attempts });
          LET $used = IF $count > $counter { $count } ELSE { $counter };
          LET $existingPayload = IF $existingKey = NONE { NONE } ELSE { $existingKey.payload_hash };
          LET $committed = (SELECT math::sum(attempt_limit - attempts) FROM internal_ai_window WHERE envelope = NONE AND activity = $activityName AND status = "active" AND <datetime>evidence_expires_at > time::now() GROUP ALL)[0]["math::sum"] ?? 0;
          LET $new = $existingKey = NONE;
          IF $existingKey != NONE AND $existingPayload != $payload { THROW "magpie-window-idempotency-conflict"; };
          IF $new AND $existingApproval != NONE { THROW "magpie-window-approval-consumed"; };
          IF $new AND <datetime>$expires <= time::now() { THROW "magpie-window-evidence-expired"; };
          IF $new AND $isEnvelope = false AND ($sourceUsd > $a.total_limit OR $perUsd > $a.per_attempt_limit) { THROW "magpie-window-cap-inheritance"; };
          IF $new AND $isEnvelope AND $envelope = NONE { THROW "magpie-window-envelope-invalid"; };
          IF $new AND $isEnvelope AND (time::now() >= <datetime>$envelopeExpiry OR <datetime>$expires > <datetime>$envelopeExpiry) { THROW "magpie-window-envelope-expired"; };
          IF $new AND $isEnvelope AND ($sourceUsd > 700000000 OR $perUsd > 35000000 OR $envelope.allocated_nano_usd + $sourceUsd > 700000000) { THROW "magpie-window-envelope-cap-exceeded"; };
          IF $new AND $isEnvelope AND $envelope.attempts + $envelope.committed_attempts + $sourceAttempts > 20 { THROW "magpie-window-remaining-insufficient"; };
          IF $new AND $isEnvelope = false AND $sourceAttempts > 30 - $used - $committed { THROW "magpie-window-remaining-insufficient"; };
          IF $new {
            CREATE ONLY $row CONTENT {
              activity: $activityName, approval_digest: $approval, approval_task: $approvalTask, account_ref: $accountRef,
              evidence_expires_at: $expires, envelope: IF $isEnvelope { $envelopeName } ELSE { NONE }, attempt_limit: $sourceAttempts, source_budget_nano_usd: $sourceUsd,
              per_attempt_nano_usd: $perUsd, attempts: 0, reserved: 0, spent: 0, status: "active", revision: 1,
              route_revision: $routeRevision, route_digest: $routeDigest, requested_model: $requestedModel,
              served_model: $servedModel, endpoint: $endpoint, account_binding: $accountBinding,
              price_revision: $priceRevision, price_basis: $priceBasis, free_evidence_hash: IF $freeEvidenceHash = NULL { NONE } ELSE { $freeEvidenceHash },
              amortized_nano_usd: IF $amortized = NULL { NONE } ELSE { $amortized }, marginal_nano_usd: IF $marginal = NULL { NONE } ELSE { $marginal }, max_output_tokens: $maxOutput,
              sampled_at: $sampledAt, route_expires_at: $routeExpires,
              capacity_database: $capacityDatabase, capacity_tables: $capacityTables, capacity_fields: $capacityFields,
              capacity_records: $capacityRecords, capacity_ttl_seconds: $capacityTtl,
              capacity_destructive: $capacityDestructive, capacity_source: $capacitySource,
              idempotency_key: $idem, payload_hash: $payload, operator: $operator, reason: $reason
            };
            IF $isEnvelope { UPDATE ONLY $envelopeId SET allocated_nano_usd += $sourceUsd, committed_attempts += $sourceAttempts; };
          } ELSE {
            UPDATE ONLY $activityId SET window_revision = window_revision - 1;
          };
          COMMIT TRANSACTION;`, {
          activityId: activityId, activityName: input.activity, row, idem: input.idempotencyKey, payload: digest,
          targetId: new RecordId("internal_ai_target", GOAL), cycleId: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE),
          approval: input.approvalDigest, approvalTask: input.approvalTask, accountRef: input.accountRef,
          expires: input.evidenceExpiresAt, sourceAttempts: input.sourceBudgetAttempts, sourceUsd: input.sourceBudgetNanoUsd,
          perUsd: input.perAttemptNanoUsd, routeRevision: input.route.revision, routeDigest: input.route.digest,
          requestedModel: input.route.requestedModel, servedModel: input.route.servedModel, endpoint: input.route.endpoint,
          accountBinding: input.route.accountBinding, priceRevision: input.route.priceRevision, priceBasis: input.route.priceBasis,
          freeEvidenceHash: input.route.freeEvidenceHash ?? null, amortized: input.route.amortizedNanoUsd ?? null,
          marginal: input.route.marginalNanoUsd ?? null, maxOutput: input.route.maxOutputTokens, sampledAt: input.route.sampledAt,
          routeExpires: input.route.expiresAt, capacityDatabase: input.capacity.database, capacityTables: input.capacity.entityTables,
          capacityFields: input.capacity.fieldsPerTable, capacityRecords: input.capacity.recordsPerTable,
          capacityTtl: input.capacity.ttlSeconds, capacityDestructive: input.capacity.destructive,
          capacitySource: input.capacity.source, operator, reason: input.reason,
          isEnvelope: input.envelope === MAGPIE_B_ENVELOPE.id, envelopeId: new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id), envelopeName: input.envelope ?? null,
          envelopeExpiry: MAGPIE_B_ENVELOPE.expiresAt,
        });
        const found = rows<WindowRow>(await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity AND idempotency_key = $idem LIMIT 1", { activity: input.activity, idem: input.idempotencyKey }))[0];
        if (!found) throw new Error("magpie-window-unconfirmed");
        return { window: found, idempotentReplay: String(found.id) !== String(row) };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (retry < 8 && raw.includes("can be retried")) continue;
        // 事务内 THROW 会被引擎折叠成 failed transaction；用幂等键/批准摘要回读把并发结果说清楚。
        let raced: WindowRow | undefined;
        let consumed: WindowRow | undefined;
        try {
          raced = rows<WindowRow>(await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity AND idempotency_key = $idem LIMIT 1", { activity: input.activity, idem: input.idempotencyKey }))[0];
          if (!raced) consumed = rows<WindowRow>(await db.query("SELECT * FROM internal_ai_window WHERE activity = $activity AND approval_digest = $approval LIMIT 1", { activity: input.activity, approval: input.approvalDigest }))[0];
        } catch { /* 回读失败保留原始拒绝 */ }
        if (raced) {
          if (raced.payload_hash !== digest) throw new WindowDenied("magpie-window-idempotency-conflict", "同一幂等键的载荷不一致");
          return { window: raced, idempotentReplay: true };
        }
        if (consumed) throw new WindowDenied("magpie-window-approval-consumed", "该批准摘要已创建过窗口");
        // 事务内门禁 THROW 被折叠后，用同一组只读校验重放，把并发落败方归类为真实的 4xx。
        try {
          const [usedRows2, committedRows2] = await Promise.all([
            db.query("SELECT count() FROM internal_ai_attempt GROUP ALL", {}),
            db.query('SELECT math::sum(attempt_limit - attempts) FROM internal_ai_window WHERE activity = $activity AND status = "active" AND <datetime>evidence_expires_at > time::now() GROUP ALL', { activity: input.activity }),
          ]);
          const counted2 = Number(rows<{ count: number }>(usedRows2)[0]?.count ?? 0);
          const target2 = await this.target();
          const cycle2 = await this.measurementCycle();
          const envelope2 = input.envelope === MAGPIE_B_ENVELOPE.id ? await this.envelopeSummary() : undefined;
          validateWindowCreate(input, {
            totalUsed: Math.max(counted2, (target2.attempts ?? 0) + (cycle2?.attempts ?? 0)),
            committedAttempts: Number(rows<Record<string, number>>(committedRows2)[0]?.['math::sum'] ?? 0),
            activityTotalLimit: activityRow.total_limit, activityPerAttemptLimit: activityRow.per_attempt_limit,
            envelopeUsed: envelope2?.usedAttempts, envelopeCommitted: envelope2?.committedAttempts,
            envelopeCommittedNanoUsd: envelope2?.committedNanoUsd, envelopeSpentNanoUsd: envelope2?.spentNanoUsd, envelopeReservedNanoUsd: envelope2?.reservedNanoUsd,
          });
        } catch (denied) { if (denied instanceof WindowDenied) throw denied; }
        if (raw.includes("magpie-window-")) throw new WindowDenied(raw.match(/magpie-window-[a-z-]+/)?.[0] ?? "magpie-window-create-denied", "窗口创建被拒绝");
        console.warn("[magpie-window] create failed", { raw });
        throw new Error("magpie-window-create-unavailable");
      }
    }
  }
  /** 绑定窗口到活动：活动 window_revision CAS + 写锁；已绑同一窗口时幂等返回。 */
  async bindWindow(windowId: string, input: { activity: string; expectedRevision: number }, operator: string): Promise<{ window: WindowRow; activityRevision: number; idempotentReplay: boolean }> {
    const db = await this.db();
    const activity = new RecordId("internal_ai_activity", input.activity);
    const target = new RecordId("internal_ai_window", windowId);
    const before = await this.activity(input.activity);
    const alreadyBound = before?.window_id != null && String(before.window_id) === String(target);
    for (let retry = 0; ; retry++) {
      try {
        await db.query(`BEGIN TRANSACTION;
          UPDATE ONLY $activityId SET window_revision = (window_revision ?? 0) + 1;
          LET $a = (SELECT * FROM ONLY $activityId);
          LET $w = (SELECT * FROM ONLY $windowId);
          IF $a = NONE OR $w = NONE { THROW "magpie-window-unknown"; };
          LET $already = $a.window_id = $windowId;
          IF $already { UPDATE ONLY $activityId SET window_revision = window_revision - 1; };
          IF $w.activity != $activityName { THROW "magpie-window-activity-mismatch"; };
          IF $already = false AND $a.window_revision != $expected + 1 { THROW "magpie-window-revision-conflict"; };
          IF $already = false AND ($w.status != "active" OR <datetime>$w.evidence_expires_at <= time::now()) { THROW "magpie-window-evidence-expired"; };
          LET $currentId = $a.window_id;
          LET $current = IF $currentId = NONE { NONE } ELSE { (SELECT * FROM $currentId)[0] };
          LET $currentExpired = IF $current = NONE { false } ELSE { $current.status = "active" AND <datetime>$current.evidence_expires_at <= time::now() };
          LET $currentExhausted = IF $current = NONE { false } ELSE { $current.status = "active" AND $current.attempts >= $current.attempt_limit };
          // 同一活动只允许一个未过期且未耗尽的 active 窗口；旧窗口过期/耗尽后可绑定新的独立批准窗口，
          // 只把旧窗口状态改为 expired/exhausted，历史 attempt/路由/预算字段不改写。
          IF $already = false AND $current != NONE AND $current.status = "active" AND $currentExpired = false AND $currentExhausted = false { THROW "magpie-window-already-bound"; };
          IF $already = false AND $currentExpired { UPDATE ONLY $currentId SET status = "expired"; };
          IF $already = false AND $currentExhausted { UPDATE ONLY $currentId SET status = "exhausted"; };
          IF $already = false {
            UPDATE ONLY $activityId SET window_id = $windowId;
            UPDATE ONLY $windowId SET bound_at = time::now();
          };
          COMMIT TRANSACTION;`, { activityId: activity, activityName: input.activity, windowId: target, expected: input.expectedRevision, operator });
        const [w, a] = await Promise.all([
          db.query("SELECT * FROM ONLY $id", { id: target }),
          db.query("SELECT window_revision, window_id FROM ONLY $id", { id: activity }),
        ]);
        const window = rows<WindowRow>(w)[0];
        const act = rows<{ window_revision: number; window_id: RecordId | null }>(a)[0];
        if (!window || !act) throw new Error("magpie-window-unconfirmed");
        return { window, activityRevision: act.window_revision, idempotentReplay: alreadyBound };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (retry < 8 && raw.includes("can be retried")) continue;
        // 事务内 THROW 被折叠后回读一次，把 CAS/证据/重复绑定归类为真实 4xx。
        try {
          const [actRow, winRow] = await Promise.all([
            db.query("SELECT window_revision, window_id FROM ONLY $id", { id: activity }),
            db.query("SELECT * FROM ONLY $id", { id: target }),
          ]).then(([a, w]) => [rows<{ window_revision: number; window_id: RecordId | null }>(a)[0], rows<WindowRow>(w)[0]] as const);
          if (!actRow || !winRow) throw new WindowDenied("magpie-window-unknown", "窗口或活动不存在");
          if (winRow.activity !== input.activity) throw new WindowDenied("magpie-window-activity-mismatch", "窗口不属于该活动");
          if (actRow.window_id != null && String(actRow.window_id) === String(target)) return { window: winRow, activityRevision: actRow.window_revision, idempotentReplay: true };
          if (actRow.window_revision !== input.expectedRevision) throw new WindowDenied("magpie-window-revision-conflict", "活动窗口版本已变化，请重新读取");
          if (winRow.status !== "active" || Date.parse(winRow.evidence_expires_at) <= Date.now()) throw new WindowDenied("magpie-window-evidence-expired", "窗口证据已过期");
          if (actRow.window_id != null) {
            const current = await this.window(String(actRow.window_id.id));
            if (current?.status === "active" && Date.parse(current.evidence_expires_at) > Date.now() && current.attempts < current.attempt_limit) {
              throw new WindowDenied("magpie-window-already-bound", "活动已绑定另一个有效 active 窗口");
            }
          }
        } catch (classified) { if (classified instanceof WindowDenied) throw classified; }
        if (raw.includes("magpie-window-")) throw new WindowDenied(raw.match(/magpie-window-[a-z-]+/)?.[0] ?? "magpie-window-bind-denied", "窗口绑定被拒绝");
        throw new Error("magpie-window-bind-unavailable");
      }
    }
  }
  async reserve(scope: InternalScope, stage: string, tariff: Tariff, amount: number, window?: WindowRow): Promise<Attempt> {
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
          LET $window = IF $windowId = NONE OR $windowId = NULL { NONE } ELSE { (SELECT * FROM $windowId)[0] };
          LET $windowed = $window != NONE AND $window.status = "active" AND $window.activity = $activityName;
          LET $envelope = IF $windowed AND $window.envelope != NONE { (SELECT * FROM ONLY $envelopeId) } ELSE { NONE };
          LET $envelopeKey = $envelopeName;
          IF $windowed AND $a.window_id != $windowId { THROW "internal-ai-evidence-unavailable"; };
          IF $measurement {
            IF $cycle.attempts >= $cycle.attempt_limit OR <datetime>$cycle.expires_at <= time::now() { THROW "internal-ai-budget-exhausted"; };
            LET $runIdentity = (SELECT identity_hash FROM internal_ai_run WHERE run_hash = $run LIMIT 1)[0];
            LET $bound = (SELECT * FROM internal_ai_binding WHERE identity_hash = $runIdentity.identity_hash LIMIT 1)[0];
            IF $bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName OR $bound.database != $measurementDatabase { THROW "internal-ai-binding-unavailable"; };
            IF $revision != $measurementPrice OR $model != "sensenova-6.8-flash-lite" OR $provider != "openai" OR $amount != 0 OR $a.evidence_kind != "reviewed-token-plan" OR $a.balance_evidence_hash != $cycle.evidence_hash OR $a.approval_revision != $cycle.approval_revision { THROW "internal-ai-evidence-unavailable"; };
          };
          IF $a.goal != $goal OR $a.enabled != true OR $a.service_approved != true OR $a.auto_topup_disabled != true { THROW "internal-ai-evidence-unavailable"; };
          // 窗口路径：活动旧证据（已过期单例/旧批准）不再作为门禁，但窗口自身的证据期、次数上限、
          // 冻结路由与账号绑定必须逐项匹配；金额上限仍继承活动既有 USD 总/单次上限。
          IF $windowed AND $window.envelope != NONE {
            IF <datetime>$window.evidence_expires_at <= time::now() OR time::now() >= <datetime>$envelopeExpiry OR $envelope = NONE OR $envelope.goal != $envelopeGoal OR $envelope.max_attempts != 20 OR $envelope.total_nano_usd != 700000000 OR $envelope.per_attempt_nano_usd != 35000000 OR $envelope.expires_at != $envelopeExpiry { THROW "internal-ai-evidence-unavailable"; };
            IF $window.attempts >= $window.attempt_limit OR $envelope.attempts >= 20 OR $window.envelope != $envelopeKey { THROW "internal-ai-budget-exhausted"; };
            IF $amount > 35000000 OR $envelope.spent + $envelope.reserved + $amount > 700000000 { THROW "internal-ai-budget-exhausted"; };
          };
          IF $windowed {
            IF $window.evidence_expires_at = NONE OR <datetime>$window.evidence_expires_at <= time::now() { THROW "internal-ai-evidence-unavailable"; };
            IF $window.attempts >= $window.attempt_limit { THROW "internal-ai-budget-exhausted"; };
            IF $window.requested_model != $model OR $window.price_revision != $revision OR $window.account_binding != $accountBinding { THROW "internal-ai-route-drift"; };
            IF $window.price_basis = "unknown" { THROW "internal-ai-price-unassessed"; };
            IF $amount > $window.per_attempt_nano_usd OR $window.spent + $window.reserved + $amount > $window.source_budget_nano_usd { THROW "internal-ai-budget-exhausted"; };
          } ELSE {
            IF $a.approval_revision = NONE OR $a.balance_evidence_hash = NONE OR string::len($a.balance_evidence_hash) != 64 OR $a.balance_source = NONE OR $a.balance_sampled_at = NONE OR $a.evidence_expires_at = NONE OR <datetime>$a.evidence_expires_at <= time::now() OR $revision NOT IN $a.price_revisions { THROW "internal-ai-evidence-unavailable"; };
            IF $a.evidence_kind = "reviewed-token-plan" {
              IF $a.plan_name = NONE OR string::len($a.plan_name) = 0 OR $a.plan_source_url = NONE OR $a.quota_unit = NONE OR $a.quota_amount = NONE OR $a.quota_amount <= 0 OR $a.quota_window_seconds = NONE OR ($a.quota_remaining != NONE AND $a.quota_remaining <= 0) OR $a.account_plan_type != $tokenPlanFree OR $a.balance_nano_usd != NONE OR $a.balance_currency != NONE OR $a.balance_source != "token-plan:" + $a.balance_evidence_hash OR $amount != 0 { THROW "internal-ai-evidence-unavailable"; };
            } ELSE {
              IF $a.balance_nano_usd = NONE OR $a.balance_nano_usd <= 0 OR $a.balance_currency != "USD" OR $a.balance_source != "reviewed-document:" + $a.balance_evidence_hash { THROW "internal-ai-evidence-unavailable"; };
            };
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
          IF ($measurement = false AND $windowed = false AND $total.attempts >= 30) OR ($windowed AND $window.envelope = NONE AND $total.attempts >= 30) OR (($windowed = false OR $window.envelope = NONE) AND $total.spent + $total.reserved + $amount > 1000000000) { THROW "internal-ai-budget-exhausted"; };
          IF $amount > $a.per_attempt_limit OR ($measurement = false AND $windowed = false AND $a.attempts >= $a.attempt_limit) OR ($windowed = false AND $a.spent + $a.reserved + $amount > $a.total_limit) OR ($windowed = false AND $a.evidence_kind != "reviewed-token-plan" AND $total.spent + $total.reserved + $amount > $a.balance_nano_usd) { THROW "internal-ai-budget-exhausted"; };
          IF $measurement {
            UPDATE ONLY $cycleId SET attempts += 1;
          } ELSE IF $windowed AND $window.envelope != NONE {
            UPDATE ONLY $windowId SET attempts += 1, reserved += $amount;
            UPDATE ONLY $envelopeId SET attempts += 1, reserved += $amount, revision += 1;
          } ELSE IF $windowed {
            UPDATE ONLY $windowId SET attempts += 1, reserved += $amount;
            UPDATE ONLY $target SET reserved += $amount, attempts += 1;
            UPDATE ONLY $activity SET reserved += $amount, attempts += 1;
          } ELSE {
            UPDATE ONLY $target SET reserved += $amount, attempts += 1;
            UPDATE ONLY $activity SET reserved += $amount, attempts += 1;
          };
          // measurement 模式下 sequence 延续该活动全部历史账本：周期轮换重置 cycle.attempts，
          // 基于它派生会撞 internal_ai_sequence (activity, sequence) 唯一索引；现金路径保持 a.attempts+1 不变。
          // 子查询只在 measurement 分支求值（IF 惰性），并发由上行 cycle/activity 写冲突串行化重试。
          CREATE ONLY $attempt CONTENT { activity: $activity, sequence: IF $measurement OR ($windowed AND $window.envelope != NONE) { ((SELECT sequence FROM internal_ai_attempt WHERE activity = $activity ORDER BY sequence DESC LIMIT 1)[0].sequence ?? 0) + 1 } ELSE { $a.attempts + 1 }, measurement_cycle: IF $measurement { $cycleName } ELSE { NONE }, window: IF $windowed { $windowId } ELSE { NONE }, envelope: IF $windowed { $window.envelope } ELSE { NONE }, retry_index: 0, run_hash: $run, key_hash: $key, logical_hash: $logical, stage: $stage, provider: $provider, model: $model, requested_model: $model, served_model: NONE, route_revision: IF $windowed { $window.route_revision } ELSE { NONE }, route_digest: IF $windowed { $window.route_digest } ELSE { NONE }, account_binding: IF $windowed { $window.account_binding } ELSE { NONE }, actual_model: NONE, request_id: NONE, reserved: $amount, cost: NONE, state: "reserved", usage: NONE, usage_raw: NONE, usage_source: "unknown", cost_status: NONE, amortized_cost_nano_usd: NONE, marginal_cost_nano_usd: NONE, price_basis: IF $windowed { $window.price_basis } ELSE { NONE }, failure_class: NONE, route_drift: false, price_revision: $revision, currency: "USD", started_at: time::now(), ended_at: NONE };
          COMMIT TRANSACTION;`, { activity, activityName: scope.activity, cycleId: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), cycleName: MEASUREMENT_CYCLE, measurementPrice: MEASUREMENT_PRICE, measurementDatabase: MEASUREMENT_DATABASE, attempt, target: new RecordId("internal_ai_target", GOAL), goal: GOAL, revision: tariff.revision, amount, run: scope.runHash, key: scope.keyHash, logical: scope.logicalHash, stage, provider: tariff.provider, model: tariff.model, tokenPlanFree: TOKEN_PLAN_PLAN_TYPE_FREE, windowId: window?.id ?? null, accountBinding: window?.account_binding ?? null, envelopeId: window?.envelope === MAGPIE_B_ENVELOPE.id ? new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id) : null, envelopeName: window?.envelope ?? null, envelopeExpiry: MAGPIE_B_ENVELOPE.expiresAt, envelopeGoal: MAGPIE_B_ENVELOPE.goal });
        void result;
        const found = rows<Attempt>(await db.query("SELECT * FROM ONLY $attempt", { attempt }))[0];
        if (!found) throw new Error("internal-ai-reservation-unconfirmed");
        return found;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (retry < 8 && raw.includes("can be retried")) continue;
        if (raw.includes("internal-ai-route-drift")) throw new Error("internal-ai-route-drift");
        if (raw.includes("internal-ai-price-unassessed")) throw new Error("internal-ai-price-unassessed");
        if (raw.includes("budget-exhausted")) throw new Error("internal-ai-budget-exhausted");
        const reason = await this.reserveDenial(scope, tariff, amount, raw, window);
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
  private async reserveDenial(scope: InternalScope, tariff: Tariff, amount: number, raw: string, window?: WindowRow): Promise<ReserveDenial> {
    if (raw.includes("internal-ai-binding-unavailable")) return "identity";
    if (raw.includes("internal-ai-route-drift") || raw.includes("internal-ai-price-unassessed")) return "evidence";
    if (raw.includes("internal-ai-evidence-unavailable")) return "evidence";
    try {
      // db.query 返回按语句排列的结果数组：各 LET 占 null 位，RETURN 的对象在末位。
      const result = await (await this.db()).query(`
        LET $total = (SELECT * FROM ONLY $target);
        LET $a = (SELECT * FROM ONLY $activity);
        LET $cycle = (SELECT * FROM ONLY $cycleId);
        LET $measurement = $cycle != NONE AND $cycle.activity = $activityName;
        LET $window = IF $windowId = NONE OR $windowId = NULL { NONE } ELSE { (SELECT * FROM $windowId)[0] };
        LET $windowed = $window != NONE AND $window.status = "active" AND $window.activity = $activityName;
        LET $envelope = IF $windowed AND $window.envelope != NONE { (SELECT * FROM ONLY $envelopeId) } ELSE { NONE };
        LET $envelopeKey = $envelopeName;
        LET $runIdentity = (SELECT identity_hash FROM internal_ai_run WHERE run_hash = $run LIMIT 1)[0];
        LET $bound = (SELECT * FROM internal_ai_binding WHERE identity_hash = $runIdentity.identity_hash LIMIT 1)[0];
        RETURN {
          cycleBudget: $measurement AND ($cycle.attempts >= $cycle.attempt_limit OR <datetime>$cycle.expires_at <= time::now()),
          binding: $measurement AND ($bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName OR $bound.database != $measurementDatabase),
          measurementEvidence: $measurement AND ($revision != $measurementPrice OR $model != "sensenova-6.8-flash-lite" OR $provider != "openai" OR $amount != 0
            OR $a.evidence_kind != "reviewed-token-plan" OR $a.balance_evidence_hash != $cycle.evidence_hash OR $a.approval_revision != $cycle.approval_revision),
          evidence: $a.goal != $goal OR $a.enabled != true OR $a.service_approved != true OR $a.auto_topup_disabled != true
            OR ($windowed = false AND ($a.approval_revision = NONE
            OR $a.balance_evidence_hash = NONE OR string::len($a.balance_evidence_hash) != 64 OR $a.balance_source = NONE OR $a.balance_sampled_at = NONE
            OR $a.evidence_expires_at = NONE OR <datetime>$a.evidence_expires_at <= time::now() OR $revision NOT IN $a.price_revisions
            OR (IF $a.evidence_kind = "reviewed-token-plan" { $a.plan_name = NONE OR string::len($a.plan_name) = 0 OR $a.plan_source_url = NONE OR $a.quota_unit = NONE OR $a.quota_amount = NONE OR $a.quota_amount <= 0 OR $a.quota_window_seconds = NONE OR ($a.quota_remaining != NONE AND $a.quota_remaining <= 0) OR $a.account_plan_type != $tokenPlanFree OR $a.balance_nano_usd != NONE OR $a.balance_currency != NONE OR $a.balance_source != "token-plan:" + $a.balance_evidence_hash OR $amount != 0 } ELSE { $a.balance_nano_usd = NONE OR $a.balance_nano_usd <= 0 OR $a.balance_currency != "USD" OR $a.balance_source != "reviewed-document:" + $a.balance_evidence_hash }))),
          windowEvidence: $windowed AND ($window.evidence_expires_at = NONE OR <datetime>$window.evidence_expires_at <= time::now()
            OR $window.requested_model != $model OR $window.price_revision != $revision OR $window.account_binding != $accountBinding OR $window.price_basis = "unknown"
            OR ($window.envelope != NONE AND (<datetime>$envelopeExpiry <= time::now() OR $envelope = NONE))),
          registeredBinding: $a.registration_jti != NONE AND ($bound = NONE OR $bound.revoked = true OR $bound.activity != $activityName),
          budget: ($windowed AND $window.envelope != NONE AND ($window.attempts >= $window.attempt_limit OR $window.envelope != $envelopeName OR $window.spent + $window.reserved + $amount > $window.source_budget_nano_usd OR ($envelope != NONE AND ($envelope.attempts >= 20 OR $amount > 35000000 OR $envelope.spent + $envelope.reserved + $amount > 700000000)))) OR ($measurement = false AND $windowed = false AND $total != NONE AND $total.attempts >= 30) OR ($windowed AND $window.envelope = NONE AND $total != NONE AND $total.attempts >= 30) OR (($windowed = false OR $window.envelope = NONE) AND ($total.spent ?? 0) + ($total.reserved ?? 0) + $amount > 1000000000)
            OR ($windowed AND $window.attempts >= $window.attempt_limit) OR ($windowed AND $amount > $window.per_attempt_nano_usd)
            OR ($windowed AND ($window.spent ?? 0) + ($window.reserved ?? 0) + $amount > $window.source_budget_nano_usd)
            OR ($a.per_attempt_limit != NONE AND $amount > $a.per_attempt_limit) OR ($measurement = false AND $windowed = false AND $a.attempt_limit != NONE AND $a.attempts != NONE AND $a.attempts >= $a.attempt_limit) OR ($a.total_limit != NONE AND ($a.spent ?? 0) + ($a.reserved ?? 0) + $amount > $a.total_limit)
            OR ($windowed = false AND $a.evidence_kind != "reviewed-token-plan" AND ($total.spent ?? 0) + ($total.reserved ?? 0) + $amount > ($a.balance_nano_usd ?? 0)),
          ledgerMax: (SELECT sequence FROM internal_ai_attempt WHERE activity = $activity ORDER BY sequence DESC LIMIT 1)[0].sequence
        };`, { activity: new RecordId("internal_ai_activity", scope.activity), activityName: scope.activity, cycleId: new RecordId("internal_ai_measurement_cycle", MEASUREMENT_CYCLE), measurementPrice: MEASUREMENT_PRICE, measurementDatabase: MEASUREMENT_DATABASE, target: new RecordId("internal_ai_target", GOAL), goal: GOAL, revision: tariff.revision, amount, run: scope.runHash, provider: tariff.provider, model: tariff.model, tokenPlanFree: TOKEN_PLAN_PLAN_TYPE_FREE, accountBinding: window?.account_binding ?? null, windowId: window?.id ?? null, envelopeId: window?.envelope === MAGPIE_B_ENVELOPE.id ? new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id) : null, envelopeName: window?.envelope ?? null, envelopeExpiry: MAGPIE_B_ENVELOPE.expiresAt });
      const gates = (Array.isArray(result) ? result.at(-1) : result) as { cycleBudget: boolean; binding: boolean; measurementEvidence: boolean; evidence: boolean; windowEvidence: boolean; registeredBinding: boolean; budget: boolean; ledgerMax: number | null } | undefined;
      // 与事务内门禁评估顺序一致：周期预算 → 测量绑定 → 测量证据 → 活动证据 → 登记绑定 → 目标/活动预算。
      if (gates?.cycleBudget) return "budget";
      if (gates?.binding) return "identity";
      if (gates?.measurementEvidence || gates?.evidence || gates?.windowEvidence) return "evidence";
      if (gates?.registeredBinding) return "identity";
      if (gates?.budget) return "budget";
      return "persist";
    } catch (probeErr) { console.warn("[internal-ai] denial probe failed", { error: probeErr instanceof Error ? probeErr.name : "unknown" }); return "persist"; }
  }
  async sent(id: RecordId): Promise<void> {
    const result = rows<Attempt>(await (await this.db()).query('UPDATE ONLY $id SET state = "sent" WHERE state = "reserved" RETURN AFTER', { id }));
    if (result.length !== 1) throw new Error("internal-ai-attempt-replayed");
  }
  async finish(id: RecordId, input: { usage: Usage | null; actualModel: string | null; requestId: string | null; cost: number | null; failed: boolean; usageRaw?: Record<string, unknown> | null; costStatus?: string | null; amortized?: number | null; marginal?: number | null; failureClass?: string | null; routeDrift?: boolean }): Promise<void> {
    const db = await this.db();
    for (let retry = 0; ; retry++) {
      try {
        await db.query(`BEGIN TRANSACTION;
          LET $r = (SELECT * FROM ONLY $id);
          IF $r.state = "sent" {
            IF $cost != NONE AND $cost != NULL AND $cost <= $r.reserved AND $failed = false {
              // 包络归属的 attempt 只结算自己的窗口与包络账本，不触碰旧 target/activity 计数。
              IF $r.envelope = NONE {
                UPDATE ONLY $target SET reserved -= $r.reserved, spent += $cost;
                UPDATE ONLY $r.activity SET reserved -= $r.reserved, spent += $cost;
              };
              IF $r.window != NONE AND $r.window != NULL { UPDATE ONLY $r.window SET reserved -= $r.reserved, spent += $cost; };
              IF $r.envelope != NONE AND $r.envelope != NULL { UPDATE ONLY $envelopeId SET reserved -= $r.reserved, spent += $cost, revision += 1; };
              UPDATE ONLY $id SET state = "settled", cost = $cost;
            } ELSE { UPDATE ONLY $id SET state = "uncertain"; };
            UPDATE ONLY $id SET usage = IF $usage = NULL { NONE } ELSE { $usage }, actual_model = IF $model = NULL { NONE } ELSE { $model }, served_model = IF $model = NULL { NONE } ELSE { $model }, request_id = IF $request = NULL { NONE } ELSE { $request }, usage_source = IF $usage = NONE OR $usage = NULL { "unknown" } ELSE { "provider" }, usage_raw = IF $usageRaw = NULL { NONE } ELSE { $usageRaw }, cost_status = IF $costStatus = NULL { NONE } ELSE { $costStatus }, amortized_cost_nano_usd = IF $amortized = NULL { NONE } ELSE { $amortized }, marginal_cost_nano_usd = IF $marginal = NULL { NONE } ELSE { $marginal }, failure_class = IF $failure = NULL { NONE } ELSE { $failure }, route_drift = $drift, ended_at = time::now();
          };
          COMMIT TRANSACTION;`, { id, target: new RecordId("internal_ai_target", GOAL), envelopeId: new RecordId("internal_ai_envelope", MAGPIE_B_ENVELOPE.id), usage: input.usage, model: input.actualModel, request: input.requestId, cost: input.cost, failed: input.failed, usageRaw: input.usageRaw ?? null, costStatus: input.costStatus ?? null, amortized: input.amortized ?? null, marginal: input.marginal ?? null, failure: input.failureClass ?? null, drift: input.routeDrift === true });
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
