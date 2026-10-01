import { isRetryableConflict, QueryError, StringRecordId, SurrealError } from "surrealdb";

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
  /** thenable 语义：await 后得到全语句结果数组（SDK Query 与插桩会话均满足）。 */
  query(sql: string, bindings?: Record<string, unknown>): PromiseLike<unknown>;
};

/**
 * 可安全重试的事务冲突判定：3.1+ 引擎给结构化 TransactionConflict（isRetryableConflict），
 * 旧引擎只回纯文本 "The query was not executed due to a failed transaction"（生产实测复现）。
 */
export function isRetryableTxnError(error: unknown): boolean {
  if (isRetryableConflict(error)) return true;
  return error instanceof QueryError && /failed transaction|transaction conflict/i.test(error.message);
}

/** 账本会话错误归一：事务冲突由调用方重试；其余 SurrealDB 错误解释成 unavailable（503）。 */
function toAllowanceError(error: unknown): never {
  if (error instanceof AiAllowanceError) throw error;
  if (isRetryableTxnError(error)) throw error;
  if (error instanceof SurrealError) {
    throw new AiAllowanceError("ai-allowance-unavailable", "AI allowance ledger is unavailable; retry later", {
      cause: error.name,
    });
  }
  throw error;
}

async function collect(session: Queryable, sql: string, bindings?: Record<string, unknown>): Promise<unknown> {
  try {
    return await session.query(sql, bindings);
  } catch (error) {
    return toAllowanceError(error);
  }
}

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
  /** LCA08：商业来源终止标记（试用转付费），旧记录上为 NONE。 */
  terminated_at?: unknown;
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
  /** 可用总额（未到期、未暂停、未终止）。 */
  available: number;
  /** 进行中预留总额（未到期桶上）。 */
  reserved: number;
  /** 暂停桶内仍有余额。 */
  suspended: number;
  /** 已终止桶（试用转付费等商业来源终止）内仍有余额，不再可消费、不复活。 */
  terminated: number;
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
/** 桶条件扣减的事务冲突重试上限；抖动退避，超限归一为 retryable unavailable。 */
const MAX_RESERVE_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      await collect(sys, `SELECT db_name FROM workspace WHERE db_name = $w OR slug = $w LIMIT 1`, { w: workspace }),
    );
    return typeof row?.db_name === "string" ? row.db_name : null;
  }

  /** workspace db_name → 产品权益快照里的 ai_actions；无快照返回 null（遗留未计量路径）。 */
  async entitledActions(dbName: string): Promise<readonly string[] | null> {
    const gate = await this.entitlementGate(dbName);
    return gate ? gate.actions : null;
  }

  /**
   * LCA08 读端门禁：权益动作 + 当前有效商业来源前缀（`<kind>:<sourceId>:`）。
   * plan_cycle 桶的可消费资格必须对齐当前商业来源：试用转付费后旧试用桶立即
   * 失去资格（即便 terminated_at 标记尚未落库，读端也按当前来源 fail-closed）；
   * 快照缺失或 base_source_kind = none 时 plan_cycle 桶一律不可消费（保留模式
   * 停止新的计量动作，不扩大访问）。购买/补偿桶不受来源更替影响。
   */
  private async entitlementGate(dbName: string): Promise<{
    actions: readonly string[];
    planCyclePrefix: string | null;
  } | null> {
    const sys = await this.deps.systemSession();
    const row = first<{ ai_actions?: unknown; base_kind?: unknown; base_id?: unknown }>(
      await collect(
        sys,
        `SELECT current_product_entitlement.ai_actions AS ai_actions,
                current_product_entitlement.base_source_kind AS base_kind,
                current_product_entitlement.base_source_id AS base_id
         FROM workspace WHERE db_name = $db LIMIT 1`,
        { db: dbName },
      ),
    );
    if (!row || !Array.isArray(row.ai_actions)) return null;
    const baseKind = row.base_kind;
    const baseId = typeof row.base_id === "string" ? row.base_id : null;
    const planCyclePrefix = (baseKind === "trial" || baseKind === "subscription") && baseId
      ? `${String(baseKind)}:${baseId}:`
      : null;
    return { actions: row.ai_actions.map(String), planCyclePrefix };
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
    const gate = await this.entitlementGate(input.db);
    if (!gate) return { metered: false };
    if (!gate.actions.includes(input.actionKey)) {
      throw new AiAllowanceError("ai-action-not-entitled", `AI action ${input.actionKey} is not in the workspace entitlement`, { actionKey: input.actionKey });
    }

    const session = await this.deps.workspaceSession(input.db);
    await this.sweepExpired(session);

    const rate = first<{ id: unknown; amount: number; revision: number }>(
      await collect(
        session,
        `SELECT id, amount, revision FROM ai_rate_card
         WHERE action_key = $action AND status = "active"
         ORDER BY revision DESC LIMIT 1`,
        { action: input.actionKey },
      ),
    );
    if (!rate) {
      throw new AiAllowanceError("ai-action-unmetered", `no active rate revision for action ${input.actionKey}`, { actionKey: input.actionKey });
    }
    const amount = rate.amount;

    const existing = first<ReservationRow>(
      await collect(session, `SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey }),
    );
    if (existing) return { metered: true, reservation: existing, reused: true };

    // 桶 UPDATE 的条件扣减在并发下会以事务冲突失败；冲突可安全重试——
    // 每轮重取候选桶（余额可能已被别路消耗→自然落到 insufficient）。
    for (let attempt = 0; ; attempt += 1) {
      // 消费顺序：最早到期 → 同到期套餐/补偿先于购买 → 创建序（ORDER BY 只接 idiom，先投影再排）。
      // LCA08 读端 fail-closed：已终止桶（试用转付费）不参与新预留；plan_cycle 桶
      // 还必须对齐当前有效商业来源前缀，快照缺失/来源翻转发时不复活旧资格。
      const candidates = rows<{ id: unknown }>(
        await collect(
          session,
          `SELECT id, expires_at, created_at, (kind = "purchased") AS purchased_last FROM ai_allowance_bucket
           WHERE status = "active" AND effective_from <= time::now() AND expires_at > time::now()
             AND available >= $amt AND terminated_at = NONE
             AND (kind != "plan_cycle" OR string::startsWith(period_key, $planPrefix))
           ORDER BY expires_at ASC, purchased_last ASC, created_at ASC`,
          { amt: amount, planPrefix: gate.planCyclePrefix ?? "\u0000no-valid-plan-source" },
        ),
      );

      let conflict = false;
      for (const candidate of candidates) {
        try {
          await collect(
            session,
            `BEGIN;
             LET $u = (UPDATE $bucket SET available -= $amt, reserved += $amt
                       WHERE available >= $amt AND status = "active" AND expires_at > time::now()
                         AND terminated_at = NONE);
             IF array::len($u) > 0 {
               LET $res = (CREATE ONLY ai_reservation CONTENT {
                 actor: $actor, channel: $channel, action_key: $action, rate: $rate,
                 idempotency_key: $key, run_id: $runId, bucket: $bucket,
                 max_amount: $amt, deadline: time::now() + duration::from_millis($window)
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
              window: this.windowMs,
            },
          );
        } catch (error) {
          // 幂等键冲突 → 并发重试中的另一路已落账；返回既有预留即可。
          const raced = first<ReservationRow>(
            await collect(session, `SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey }),
          );
          if (raced) return { metered: true, reservation: raced, reused: true };
          if (isRetryableTxnError(error)) {
            conflict = true;
            break;
          }
          throw error;
        }
        const created = first<ReservationRow>(
          await collect(session, `SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey }),
        );
        if (created) return { metered: true, reservation: created, reused: false };
      }
      if (!conflict) break;
      if (attempt + 1 >= MAX_RESERVE_ATTEMPTS) {
        throw new AiAllowanceError("ai-allowance-unavailable", "allowance ledger write is contended; retry later", {
          actionKey: input.actionKey,
          retryable: true,
        });
      }
      await sleep(5 + Math.random() * 20 * (attempt + 1));
    }

    throw new AiAllowanceError("ai-allowance-insufficient", "workspace AI allowance cannot cover the disclosed maximum", {
      actionKey: input.actionKey,
      required: amount,
    });
  }

  /** 恢复重新检查当前动作权益；只延续仍有效的预留。新窗口按原预留身份派生幂等键。 */
  async resume(input: { db: string; actor: StringRecordId; runId: string; actionKey: string; idempotencyKey: string }): Promise<{ metered: boolean }> {
    const actions = await this.entitledActions(input.db);
    if (actions === null) return { metered: false };
    if (!actions.includes(input.actionKey)) throw new AiAllowanceError("ai-action-not-entitled", "当前权益不允许继续此 AI 动作");
    const session = await this.deps.workspaceSession(input.db);
    await this.sweepExpired(session);
    const latest = first<ReservationRow>(await collect(session,
      `SELECT * FROM ai_reservation WHERE run_id = $run ORDER BY created_at DESC LIMIT 1`, { run: input.runId }));
    if (latest && String(latest.actor) !== String(input.actor)) throw new AiAllowanceError("ai-action-not-entitled", "运行不属于当前调用者");
    if (latest?.status === "reserved") return { metered: true };
    // 已交付动作的断线重试不另扣款；再次研究从新 run 开始。
    if (latest?.status === "settled") return { metered: true };
    return this.reserve({ ...input, channel: "interactive", idempotencyKey: `${input.idempotencyKey}:after:${String(latest?.id ?? "initial")}` });
  }

  /** 结算：charge ≤ 预留披露上限；缺省按上限全额。幂等（终态直返）。 */
  async settle(input: { db: string; idempotencyKey: string; amount?: number; note?: string }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    const reservation = first<ReservationRow>(
      await collect(session, `SELECT * FROM ai_reservation WHERE idempotency_key = $key`, { key: input.idempotencyKey }),
    );
    if (!reservation || reservation.status !== "reserved") return;

    const charge = input.amount ?? reservation.max_amount;
    if (!Number.isInteger(charge) || charge < 0 || charge > reservation.max_amount) {
      throw new AiAllowanceError("ai-allowance-unavailable", `settle amount ${charge} exceeds disclosed maximum`, {
        max: reservation.max_amount,
      });
    }

    await collect(
      session,
      `BEGIN;
       LET $r = (SELECT * FROM ai_reservation WHERE idempotency_key = $key AND status = "reserved")[0];
       IF $r != NONE {
         UPDATE ONLY $r.id SET status = "settled", settled_amount = $charge,
           outcome = $outcome, resolved_at = time::now();
         UPDATE ONLY $r.bucket SET reserved -= $r.max_amount, settled += $charge;
         LET $b = (SELECT expires_at, terminated_at FROM ONLY $r.bucket);
         LET $excess = $r.max_amount - $charge;
         CREATE ai_ledger_entry CONTENT {
           kind: "settle", bucket: $r.bucket, reservation: $r.id, amount: $charge,
           note: $note, resulting_available: (SELECT VALUE available FROM ONLY $r.bucket)[0]
         };
         // LCA08：已终止桶（试用转付费）的未用预留只冲销，不返还可消费余额。
         IF $excess > 0 {
           IF $b.expires_at > time::now() AND $b.terminated_at = NONE {
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
    );

    await this.emitThresholdNotices(session, rid(reservation.bucket));
  }

  /** 释放：回原桶；原桶已到期或已终止（试用转付费）→ 只记 writeoff 不恢复可用。幂等。 */
  async release(input: { db: string; idempotencyKey: string; reason: string }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    await collect(
      session,
      `BEGIN;
       LET $r = (SELECT * FROM ai_reservation WHERE idempotency_key = $key AND status = "reserved")[0];
       IF $r != NONE {
         UPDATE ONLY $r.id SET status = "released", outcome = $reason, resolved_at = time::now();
         UPDATE ONLY $r.bucket SET reserved -= $r.max_amount;
         LET $b = (SELECT expires_at, terminated_at FROM ONLY $r.bucket);
         IF $b.expires_at > time::now() AND $b.terminated_at = NONE {
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
    );
  }

  /** run 终态收口：按 run_id 找回未决预留 → success 结算 / failure、cancelled 释放。幂等。 */
  async finishByRun(input: { db: string; runId: string; outcome: "success" | "failure" | "cancelled" }): Promise<void> {
    const session = await this.deps.workspaceSession(input.db);
    const reservation = first<ReservationRow>(
      await collect(
        session,
        `SELECT * FROM ai_reservation WHERE run_id = $run AND status = "reserved" ORDER BY created_at DESC LIMIT 1`,
        { run: input.runId },
      ),
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
      await collect(target, `SELECT id FROM ai_reservation WHERE status = "reserved" AND deadline <= time::now()`),
    );
    for (const row of overdue) {
      await collect(
        target,
        `BEGIN;
         LET $r = (SELECT * FROM ONLY $rid);
           IF $r != NONE AND $r.status = "reserved" {
             UPDATE ONLY $r.id SET status = "expired", outcome = "execution_window_expired", resolved_at = time::now();
             UPDATE ONLY $r.bucket SET reserved -= $r.max_amount;
             LET $b = (SELECT expires_at, terminated_at FROM ONLY $r.bucket);
             IF $b.expires_at > time::now() AND $b.terminated_at = NONE {
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
      );
    }
    return overdue.length;
  }

  /** 客户余额视图：可用 / 预留 / 暂停 / 已终止 / 已过期 + 桶明细。 */
  async balance(db: string): Promise<AllowanceBalance> {
    const session = await this.deps.workspaceSession(db);
    await this.sweepExpired(session);
    const gate = await this.entitlementGate(db);
    const buckets = rows<AllowanceBucketRow>(
      await collect(session, `SELECT * FROM ai_allowance_bucket ORDER BY expires_at ASC`),
    );
    const now = this.nowMs;
    const ts = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
    const balance: AllowanceBalance = { available: 0, reserved: 0, suspended: 0, terminated: 0, expired: 0, buckets };
    for (const b of buckets) {
      const expired = ts(b.expires_at) <= now;
      // LCA08：终止标记（试用转付费）或不再对齐当前商业来源的 plan_cycle 桶
      // 立即离开可消费余额，不复活（fail-closed，不事后改写桶记录）。
      const terminated = b.terminated_at != null;
      const stalePlanSource = b.kind === "plan_cycle"
        && !(typeof gate?.planCyclePrefix === "string" && String(b.period_key).startsWith(gate.planCyclePrefix));
      if (expired) balance.expired += b.available + b.reserved;
      else if (terminated || stalePlanSource) balance.terminated += b.available + b.reserved;
      else if (b.status === "suspended") balance.suspended += b.available + b.reserved;
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
    const result = await collect(
      session,
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
    );
    const bucket = first<{ id: unknown }>(Array.isArray(result) ? result[result.length - 1] : result);
    return { bucket: bucket?.id };
  }

  /** 结算后按桶 settled/total 触发 50/80/100 阈值提示（period_key×threshold 唯一去重）。 */
  private async emitThresholdNotices(session: Queryable, bucket: StringRecordId): Promise<void> {
    const row = first<{ settled: number; total: number; period_key: string; label: string }>(
      await collect(session, `SELECT settled, total, period_key, label FROM ONLY $b`, { b: bucket }),
    );
    if (!row || row.total <= 0) return;
    const percent = Math.floor((row.settled / row.total) * 100);
    for (const threshold of [50, 80, 100]) {
      if (percent < threshold) continue;
      await collect(
        session,
        `INSERT INTO ai_allowance_notice [
          { period_key: $period, threshold: $t, message: $msg }
        ] ON DUPLICATE KEY UPDATE period_key = period_key`,
        {
          period: row.period_key,
          t: threshold,
          msg: `AI 额度周期 ${row.period_key}（${row.label}）已消耗超过 ${threshold}%`,
        },
      );
    }
  }
}
