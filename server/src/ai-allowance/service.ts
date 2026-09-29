import { StringRecordId } from "surrealdb";

/**
 * LCA05 工作区共享 AI 额度账本服务。
 *
 * 归属：账本表（ai_rate_card / ai_allowance_bucket / ai_reservation /
 * ai_ledger_entry / ai_allowance_notice）在每个 workspace database 内，
 * 成员只读、仅 root 会话可写——调用方会话无法伪造余额或冲销。
 *
 * 语义（对应 SCK-LCA-05 验收标准）：
 * - 预留绑定 actor/channel/action/rate revision/bucket/idempotency key，
 *   条件扣减保证并发余额不为负，重试命中幂等键不重复扣款。
 * - 消费顺序：最早到期优先；同到期时套餐/补偿先于购买；再按创建序。
 * - 成功结算不超过执行前披露的 max_amount；失败/超时释放回原桶，
 *   原桶已过期则只记 writeoff 冲销、不恢复可用余额。
 * - 预留带执行窗口 deadline；失联由 sweepExpired 惰性回收（每次进出账本前扫一遍）。
 * - 结算后按桶内 settled/total 触发 50/80/100 阈值提示，(period_key, threshold) 唯一去重。
 */

export type AllowanceChannel = "interactive" | "employee" | "api_mcp" | "batch";
export type AllowanceBucketKind = "plan_cycle" | "purchased" | "compensation";

export type AiAllowanceErrorCode =
  /** 目录里没有该动作的 active 费率修订：未接入计量的收费路径不可用。 */
  | "ai-action-unmetered"
  /** 权益允许该动作，但没有任何桶能覆盖披露上限。 */
  | "ai-allowance-insufficient"
  /** 权益快照存在但该动作不在 ai_actions 内。 */
  | "ai-action-not-entitled"
  /** workspace / 账本不可用。 */
  | "ai-allowance-unavailable";

export class AiAllowanceError extends Error {
  constructor(
    readonly code: AiAllowanceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AiAllowanceError";
  }
}

export type Queryable = {
  query(sql: string, bindings?: Record<string, unknown>): { collect(): Promise<unknown[]> };
};

export type AiAllowanceDeps = {
  /** root 会话到目标 workspace database。 */
  workspaceSession(db: string): Promise<Queryable>;
  /** root 会话到 _system（workspace → 权益快照解析）。 */
  systemSession(): Promise<Queryable>;
  now?: () => number;
  /** 预留执行窗口，默认 15 分钟；覆盖 suspend/resume 全程。 */
  reservationWindowMs?: number;
};

export type AllowanceBucketRow = {
  id: unknown;
  kind: AllowanceBucketKind;
  label: string;
  period_key: string;
  total: number;
  available: number;
  reserved: number;
  settled: number;
  status: "active" | "suspended";
  effective_from: unknown;
  expires_at: unknown;
};

export type ReservationRow = {
  id: unknown;
  actor: unknown;
  channel: AllowanceChannel;
  action_key: string;
  rate: unknown;
  idempotency_key: string;
  run_id?: string;
  bucket: unknown;
  max_amount: number;
  settled_amount?: number | null;
  status: "reserved" | "settled" | "released" | "expired";
  outcome?: string | null;
  deadline: unknown;
  resolved_at?: unknown;
};

export type AllowanceBalance = {
  /** 可用总额（未到期、未暂停）。 */
  available: number;
  /** 进行中预留总额（未到期桶上）。 */
  reserved: number;
  /** 暂停桶内仍有余额。 */
  suspended: number;
  /** 已到期桶里的剩余可用。 */
  expired: number;
  buckets: AllowanceBucketRow[];
};

function first<T>(result: unknown): T | undefined {
  const statement = Array.isArray(result) ? result[0] : result;
  const arr = Array.isArray(statement) ? statement : [statement];
  return arr.find((v) => v != null) as T | undefined;
}

function rows<T>(result: unknown): T[] {
  const statement = Array.isArray(result) ? result[0] : result;
  return Array.isArray(statement) ? (statement as T[]) : [];
}

function rid(value: unknown): StringRecordId {
  if (value instanceof StringRecordId) return value;
  return new StringRecordId(String(value));
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export class AiAllowanceService {
  constructor(private readonly deps: AiAllowanceDeps) {}

  private get nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get windowMs(): number {
    return this.deps.reservationWindowMs ?? DEFAULT_WINDOW_MS;
  }

  /** slug 或 db_name → workspace database 名；找不到返回 null。 */
  async resolveWorkspaceDb(workspace: string): Promise<string | null> {
    const sys = await this.deps.systemSession();
    const row = first<{ db_name?: unknown }>(
      await sys
        .query(
          `SELECT db_name FROM workspace WHERE db_name = $w OR slug = $w LIMIT 1`,
          { w: workspace },
        )
        .collect(),
    );
    return typeof row?.db_name === "string" ? row.db_name : null;
  }

  /** workspace db_name → 产品权益快照里的 ai_actions；无快照返回 null（遗留未计量路径）。 */
  async entitledActions(dbName: string): Promise<readonly string[] | null> {
    const sys = await this.deps.systemSession();
    const row = first<{ ai_actions?: unknown }>(
      await sys
        .query(
          `SELECT current_product_entitlement.ai_actions AS ai_actions
           FROM workspace WHERE db_name = $db LIMIT 1`,
          { db: dbName },
        )
        .collect(),
    );
    if (!row || !Array.isArray(row.ai_actions)) return null;
    return row.ai_actions.map(String);
  }

  /**
   * 计量门禁：权益无快照 → {metered:false}（遗留路径）；有快照但动作不在列 → not-entitled；
   * 无 active 费率 → unmetered；无桶可覆盖 → insufficient。成功返回预留。
   */
  async reserve(input: {
    db: string;
    actor: StringRecordId;
    channel: AllowanceChannel;
    actionKey: string;
    idempotencyKey: string;
    runId: string;
  }): Promise<{ metered: false } | { metered: true; reservation: ReservationRow; reused: boolean }> {
    const actions = await this.entitledActions(input.db);
    if (actions === null) return { metered: false };
    if (!actions.includes(input.actionKey)) {
      throw new AiAllowanceError("ai-action-not-entitled", `AI action ${input.actionKey} is not in the workspace entitlement`, { actionKey: input.actionKey });
    }

    const session = await this.deps.workspaceSession(input.db);
    await this.sweepExpired(session);

    const rate = first<{ id: unknown; amount: number; revision: number }>(
      await session
        .query(
          `SELECT id, amount, revision FROM ai_rate_card
           WHERE action_key = $action AND status = "active"
           ORDER BY revision DESC LIMIT 1`,
          { action: input.actionKey },
        )
        .collect(),
    );
    if (!rate) {
      throw new AiAllowanceError("ai-action-unmetered", `no active rate revision for action ${input.actionKey}`, { actionKey: input.actionKey });
    }
    const amount = rate.amount;

    const existing = first<ReservationRow>(
      await session
        .query(`SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey })
        .collect(),
    );
    if (existing) return { metered: true, reservation: existing, reused: true };

    // 消费顺序：最早到期 → 同到期套餐/补偿先于购买 → 创建序（ORDER BY 只接 idiom，先投影再排）。
    const candidates = rows<{ id: unknown }>(
      await session
        .query(
          `SELECT id, expires_at, created_at, (kind = "purchased") AS purchased_last FROM ai_allowance_bucket
           WHERE status = "active" AND effective_from <= time::now() AND expires_at > time::now()
             AND available >= $amt
           ORDER BY expires_at ASC, purchased_last ASC, created_at ASC`,
          { amt: amount },
        )
        .collect(),
    );

    for (const candidate of candidates) {
      try {
        await session
          .query(
            `BEGIN;
             LET $u = (UPDATE $bucket SET available -= $amt, reserved += $amt
                       WHERE available >= $amt AND status = "active" AND expires_at > time::now());
             IF array::len($u) > 0 {
               LET $res = (CREATE ONLY ai_reservation CONTENT {
                 actor: $actor, channel: $channel, action_key: $action, rate: $rate,
                 idempotency_key: $key, run_id: $runId, bucket: $bucket,
                 max_amount: $amt, deadline: $deadline
               });
               CREATE ai_ledger_entry CONTENT {
                 kind: "reserve", bucket: $bucket, reservation: $res.id, amount: $amt,
                 note: "reserve for " + $action, resulting_available: $u[0].available
               };
             };
             COMMIT;`,
            {
              bucket: rid(candidate.id),
              actor: input.actor,
              channel: input.channel,
              action: input.actionKey,
              rate: rid(rate.id),
              key: input.idempotencyKey,
              runId: input.runId,
              amt: amount,
              deadline: new Date(this.nowMs + this.windowMs),
            },
          )
          .collect();
      } catch (error) {
        // 幂等键冲突 → 并发重试中的另一路已落账；返回既有预留即可。
        const raced = first<ReservationRow>(
          await session
            .query(`SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey })
            .collect(),
        );
        if (raced) return { metered: true, reservation: raced, reused: true };
        throw error;
      }
      const created = first<ReservationRow>(
        await session
          .query(`SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey })
          .collect(),
      );
      if (created) return { metered: true, reservation: created, reused: false };
    }

    throw new AiAllowanceError("ai-allowance-insufficient", "workspace AI allowance cannot cover the disclosed maximum", {
      actionKey: input.actionKey,
      required: amount,
    });
  }

  /** 结算：charge ≤ 预留披露上限；缺省按上限全额。幂等（终态直返）。 */
  async settle(input: { db: string; idempotencyKey: string; amount?: number; note?: string }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    const reservation = first<ReservationRow>(
      await session
        .query(`SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey })
        .collect(),
    );
    if (!reservation || reservation.status !== "reserved") return;

    const charge = input.amount ?? reservation.max_amount;
    if (!Number.isInteger(charge) || charge < 0 || charge > reservation.max_amount) {
      throw new AiAllowanceError("ai-allowance-unavailable", `settle amount ${charge} exceeds disclosed maximum`, {
        max: reservation.max_amount,
      });
    }

    await session
      .query(
        `BEGIN;
         LET $r = (SELECT * FROM ai_reservation WHERE idempotency_key = $key AND status = "reserved")[0];
         IF $r != NONE {
           UPDATE ONLY $r.id SET status = "settled", settled_amount = $charge,
             outcome = $outcome, resolved_at = time::now();
           UPDATE ONLY $r.bucket SET reserved -= $r.max_amount, settled += $charge;
           LET $b = (SELECT expires_at FROM ONLY $r.bucket);
           LET $excess = $r.max_amount - $charge;
           CREATE ai_ledger_entry CONTENT {
             kind: "settle", bucket: $r.bucket, reservation: $r.id, amount: $charge,
             note: $note, resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
           };
           IF $excess > 0 {
             IF $b.expires_at > time::now() {
               UPDATE ONLY $r.bucket SET available += $excess;
               CREATE ai_ledger_entry CONTENT {
                 kind: "release", bucket: $r.bucket, reservation: $r.id, amount: $excess,
                 note: "unused hold after partial settle",
                 resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
               };
             } ELSE {
               CREATE ai_ledger_entry CONTENT {
                 kind: "writeoff", bucket: $r.bucket, reservation: $r.id, amount: $excess,
                 note: "unused hold on expired bucket",
                 resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
               };
             };
           };
         };
         COMMIT;`,
        {
          key: input.idempotencyKey,
          charge,
          outcome: input.note ?? "success",
          note: input.note ?? "settled on delivered result",
        },
      )
      .collect();

    await this.emitThresholdNotices(session, rid(reservation.bucket));
  }

  /** 释放：回原桶；原桶已到期 → 只记 writeoff 不恢复可用。幂等。 */
  async release(input: { db: string; idempotencyKey: string; reason: string }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    await session
      .query(
        `BEGIN;
         LET $r = (SELECT * FROM ai_reservation WHERE idempotency_key = $key AND status = "reserved")[0];
         IF $r != NONE {
           UPDATE ONLY $r.id SET status = "released", outcome = $reason, resolved_at = time::now();
           UPDATE ONLY $r.bucket SET reserved -= $r.max_amount;
           LET $b = (SELECT expires_at FROM ONLY $r.bucket);
           IF $b.expires_at > time::now() {
             UPDATE ONLY $r.bucket SET available += $r.max_amount;
             CREATE ai_ledger_entry CONTENT {
               kind: "release", bucket: $r.bucket, reservation: $r.id, amount: $r.max_amount,
               note: $reason, resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
             };
           } ELSE {
             CREATE ai_ledger_entry CONTENT {
               kind: "writeoff", bucket: $r.bucket, reservation: $r.id, amount: $r.max_amount,
               note: $reason, resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
             };
           };
         };
         COMMIT;`,
        { key: input.idempotencyKey, reason: input.reason },
      )
      .collect();
  }

  /** run 终态收口：按 run_id 找回未决预留 → success 结算 / failure、cancelled 释放。幂等。 */
  async finishByRun(input: { db: string; runId: string; outcome: "success" | "failure" | "cancelled" }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    const reservation = first<ReservationRow>(
      await session
        .query(`SELECT * FROM ai_reservation WHERE run_id = $run AND status = "reserved" ORDER BY created_at DESC LIMIT 1`, {
          run: input.runId,
        })
        .collect(),
    );
    if (!reservation) return;
    if (input.outcome === "success") {
      await this.settle({ db: input.db, idempotencyKey: reservation.idempotency_key });
    } else {
      await this.release({
        db: input.db,
        idempotencyKey: reservation.idempotency_key,
        reason: input.outcome === "cancelled" ? "cancelled_before_terminal" : "run_failed",
      });
    }
  }

  /** 失联回收：deadline 已过的预留 → expired + 持额释放/冲销。 */
  async sweepExpired(session?: Queryable, db?: string): Promise<number> {
    const target = session ?? (db ? await this.deps.workspaceSession(db) : undefined);
    if (!target) return 0;
    const overdue = rows<{ id: unknown }>(
      await target
        .query(`SELECT id FROM ai_reservation WHERE status = "reserved" AND deadline <= time::now()`)
        .collect(),
    );
    for (const row of overdue) {
      await target
        .query(
          `BEGIN;
           LET $r = (SELECT * FROM ONLY $rid);
           IF $r != NONE AND $r.status = "reserved" {
             UPDATE ONLY $r.id SET status = "expired", outcome = "execution_window_expired", resolved_at = time::now();
             UPDATE ONLY $r.bucket SET reserved -= $r.max_amount;
             LET $b = (SELECT expires_at FROM ONLY $r.bucket);
             IF $b.expires_at > time::now() {
               UPDATE ONLY $r.bucket SET available += $r.max_amount;
               CREATE ai_ledger_entry CONTENT {
                 kind: "expire", bucket: $r.bucket, reservation: $r.id, amount: $r.max_amount,
                 note: "reservation deadline lapsed", resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
               };
             } ELSE {
               CREATE ai_ledger_entry CONTENT {
                 kind: "writeoff", bucket: $r.bucket, reservation: $r.id, amount: $r.max_amount,
                 note: "hold on expired bucket lapses", resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
               };
             };
           };
           COMMIT;`,
          { rid: rid(row.id) },
        )
        .collect();
    }
    return overdue.length;
  }

  /** 客户余额视图：可用 / 预留 / 暂停 / 已过期 + 桶明细。 */
  async balance(db: string): Promise<AllowanceBalance> {
    const session = await this.deps.workspaceSession(db);
    await this.sweepExpired(session);
    const buckets = rows<AllowanceBucketRow>(
      await session.query(`SELECT * FROM ai_allowance_bucket ORDER BY expires_at ASC`).collect(),
    );
    const now = this.nowMs;
    const ts = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
    const balance: AllowanceBalance = { available: 0, reserved: 0, suspended: 0, expired: 0, buckets };
    for (const b of buckets) {
      const expired = ts(b.expires_at) <= now;
      const suspended = b.status === "suspended";
      if (expired) balance.expired += b.available + b.reserved;
      else if (suspended) balance.suspended += b.available + b.reserved;
      else {
        balance.available += b.available;
        balance.reserved += b.reserved;
      }
    }
    return balance;
  }

  /** 运营授予：新建独立桶 + grant 账本记录。 */
  async grant(input: {
    db: string;
    kind: AllowanceBucketKind;
    amount: number;
    label: string;
    periodKey: string;
    effectiveFrom: Date;
    expiresAt: Date;
    source?: string;
    operatorSubject: string;
  }): Promise<{ bucket: unknown }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new AiAllowanceError("ai-allowance-unavailable", "grant amount must be a positive integer");
    }
    const session = await this.deps.workspaceSession(input.db);
    const result = await session
      .query(
        `BEGIN;
         LET $b = (CREATE ONLY ai_allowance_bucket CONTENT {
           kind: $kind, label: $label, source: $source, period_key: $period,
           total: $amt, available: $amt, reserved: 0, settled: 0,
           effective_from: $eff, expires_at: $exp
         });
         CREATE ai_ledger_entry CONTENT {
           kind: "grant", bucket: $b.id, amount: $amt,
           note: $note, resulting_available: $b.available
         };
         COMMIT;
         RETURN $b;`,
        {
          kind: input.kind,
          label: input.label,
          source: input.source,
          period: input.periodKey,
          amt: input.amount,
          eff: input.effectiveFrom,
          exp: input.expiresAt,
          note: `${input.kind} grant by ${input.operatorSubject}`,
        },
      )
      .collect();
    const bucket = first<{ id: unknown }>(Array.isArray(result) ? result[result.length - 1] : result);
    return { bucket: bucket?.id };
  }

  /** 结算后按桶 settled/total 触发 50/80/100 阈值提示（period_key×threshold 唯一去重）。 */
  private async emitThresholdNotices(session: Queryable, bucket: StringRecordId): Promise<void> {
    const row = first<{ settled: number; total: number; period_key: string; label: string }>(
      await session
        .query(`SELECT settled, total, period_key, label FROM ONLY $b`, { b: bucket })
        .collect(),
    );
    if (!row || row.total <= 0) return;
    const percent = Math.floor((row.settled / row.total) * 100);
    for (const threshold of [50, 80, 100]) {
      if (percent < threshold) continue;
      await session
        .query(
          `INSERT INTO ai_allowance_notice [
            { period_key: $period, threshold: $t, message: $msg }
          ] ON DUPLICATE KEY UPDATE period_key = period_key`,
          {
            period: row.period_key,
            t: threshold,
            msg: `AI 额度周期 ${row.period_key}（${row.label}）已消耗超过 ${threshold}%`,
          },
        )
        .collect();
    }
  }
}
