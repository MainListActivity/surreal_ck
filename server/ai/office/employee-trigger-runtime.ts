import { StringRecordId } from "surrealdb";
import type { EmployeeEffects } from "./employee-effects";

/**
 * 通用持久化触发 runtime（VER03 建立，VER04 加 lease/durable run/幂等副作用）。
 *
 * - adapter 只负责把外部观察翻译成 TriggerDelivery（员工、原因、payload 引用、
 *   chain depth、幂等键）交给 enqueue()；runtime 负责 employee SIGNIN、把触发
 *   持久化到 workspace 内的 employee_trigger 表、经有 lease 的执行窗口驱动一个
 *   durable workflow run、落结果、关会话。
 * - 触发记录由员工自己的 RECORD 会话写入（employee_trigger 只有 virtual 能建、
 *   employee = $auth 能改），root 不出现在这条路径上。
 * - 至少一次投递 + 幂等收敛：idempotency_key 唯一索引让重复投递撞到同一行；
 *   已 completed 的触发直接返回 coalesced，不再重跑。
 * - 执行窗口带 lease：pending 或 lease 过期（leased/running + 到期）的触发
 *   才可被原子认领（attempts+1、写 lease_expires_at/run_id）；进程消失后
 *   reconcile() 按过期 lease 回收。failed 是同键终态——业务重试须换幂等键。
 * - run 关联：每个窗口驱动 run_id 固定的 durable workflow run。snapshot
 *   status=running/waiting/pending → Mastra restart（active-run 恢复）；
 *   suspended → 触发置 waiting，只经 resumeTrigger() → run.resume 离开；
 *   终态（success/failed/tripwire/…）直接收敛触发；storage 读写失败一律
 *   fail-closed——缺 snapshot 绝不当新 run。
 * - 有副作用的动作必须经 ctx.effects.runEffect(稳定 key) 落 employee_effect
 *   账本："效果已提交、snapshot 未更新"之间崩溃，重启重放时回既有结果。
 * - 一个员工同一时刻只有一个执行窗口：同 (database, employeeId) 的窗口请求
 *   在进程内串行；跨进程由 employee_window 行的 UPSERT CAS 互斥（lease 到期
 *   可被接管）；窗口结束关闭该员工会话。
 * - 本模块不认识办公室领域表；领域读写全部发生在 adapter 注册的 handler 里。
 */

/** 执行窗口里的会话视图：handler 只能拿到这个窄接口做业务读写。 */
export type TriggerSession = {
  query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>): PromiseLike<R>;
};

/** 会话来源 seam：生产是 EmployeeRuntime，测试注入替身。 */
export type TriggerSessionManager = {
  openSession(database: string, employeeId: string): Promise<TriggerSession>;
  close(database: string, employeeId: string): Promise<void>;
};

export type TriggerDelivery = {
  /** 目标 workspace database 名。 */
  database: string;
  /** user record id（如 "user:ve_ab12…"）。 */
  employeeId: string;
  /** 触发原因；决定由哪个已注册 handler 执行。 */
  reason: string;
  /** 领域 payload 的引用（不复制大 payload 进触发记录）。 */
  payloadRef?: string;
  /** 触发链深度；顶层观察为 0，级联触发由 adapter 递增。 */
  chainDepth?: number;
  /** 幂等键：同一逻辑触发的重复投递必须撞同一个键。 */
  idempotencyKey: string;
};

export type TriggerEnvelope = {
  id: string;
  database: string;
  employeeId: string;
  reason: string;
  payloadRef: string | null;
  chainDepth: number;
  idempotencyKey: string;
};

export type TriggerHandlerContext = {
  trigger: TriggerEnvelope;
  /** 本员工的 RECORD 会话（employee access）——窗口内所有业务写必须经过它。 */
  session: TriggerSession;
  /** 幂等副作用账本：稳定 effect_key → 已提交结果回读。 */
  effects: EmployeeEffects;
  /** resumeTrigger 注入的恢复数据；非 resume 执行为 undefined。 */
  resumeData?: unknown;
  /** 显式挂起本次执行（Mastra suspend）：run 落 suspended、触发置 waiting。 */
  suspend: (payload?: unknown) => Promise<never>;
};

export type TriggerHandler = (ctx: TriggerHandlerContext) => Promise<unknown>;

/** durable run 的终态视图（runtime 只关心这三态 + 失败原因）。 */
export type EmployeeRunResult =
  | { status: "success"; output: unknown }
  | { status: "suspended" }
  | { status: "failed"; error: string };

/**
 * workflow runner seam：员工窗口与 durable workflow 引擎之间的边界。
 * 生产实现是 Mastra（employee-mastra-runner）；测试注入替身。
 */
export type EmployeeRunDriver = {
  /**
   * 严格读取既有 run 的 snapshot 状态；不存在 → null。
   * 读失败必须抛出（fail-closed），绝不把坏读降级成"没有 run"。
   */
  loadRunState(runId: string): Promise<{ status: string; result?: unknown; error?: unknown } | null>;
  start(input: { runId: string; trigger: TriggerEnvelope }): Promise<EmployeeRunResult>;
  /** Mastra active-run restart 语义：从最后一个 durable step 继续。 */
  restart(input: { runId: string; trigger: TriggerEnvelope }): Promise<EmployeeRunResult>;
  /** 显式 suspended run 的唯一恢复路径。 */
  resume(input: { runId: string; trigger: TriggerEnvelope; resumeData?: unknown }): Promise<EmployeeRunResult>;
};

export type EmployeeRunDriverFactory = (ctx: {
  session: TriggerSession;
  database: string;
  employeeId: string;
  resolveHandler: (reason: string) => TriggerHandler | undefined;
}) => EmployeeRunDriver;

export type EnqueueResult =
  | { outcome: "completed"; triggerId: string }
  /** 同一幂等键已由先前投递完成，或 lease 仍被活跃窗口持有：本次不重跑。 */
  | { outcome: "coalesced"; triggerId: string }
  /** 触发显式 suspend：等待 resumeTrigger 注入恢复数据。 */
  | { outcome: "waiting"; triggerId: string }
  | { outcome: "failed"; triggerId?: string; error: string };

export type ReconcileResult = {
  scanned: number;
  reclaimed: number;
  completed: number;
  waiting: number;
  failed: number;
};

export type EmployeeTriggerRuntime = {
  /** 打开投递闸门（重复调用幂等）。 */
  start(): void;
  /** 注册某类 reason 的岗位实现；后注册覆盖先注册。 */
  registerHandler(reason: string, handler: TriggerHandler): void;
  /** 投递一条持久化触发并等待执行窗口结束。 */
  enqueue(delivery: TriggerDelivery): Promise<EnqueueResult>;
  /**
   * 回收孤儿窗口：扫描该员工 pending / lease 已过期的 leased|running 触发，
   * 原子重新认领并恢复其 durable run（active→restart；失败→failed；
   * waiting 不动——显式 suspend 只走 resumeTrigger）。
   */
  reconcile(input: { database: string; employeeId: string }): Promise<ReconcileResult>;
  /**
   * 恢复一个 waiting 触发：装载其 suspended run 并以 resumeData 走
   * Mastra resume 语义。非 waiting 触发或 snapshot 非 suspended 都拒绝。
   */
  resumeTrigger(input: {
    database: string;
    employeeId: string;
    triggerId: string;
    resumeData?: unknown;
  }): Promise<EnqueueResult>;
  /**
   * 关闭闸门并等待在途窗口排空：之后 enqueue 一律拒绝；
   * 窗口内打开的员工会话随窗口结束全部关闭。
   */
  stop(): Promise<void>;
};

type TriggerRow = {
  id?: unknown;
  status?: unknown;
  payload_ref?: unknown;
  chain_depth?: unknown;
  reason?: unknown;
  idempotency_key?: unknown;
  run_id?: unknown;
  lease_expires_at?: unknown;
  attempts?: unknown;
  error_message?: unknown;
};

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 500);
}

/** handler 返回值落 result（option<object>）：非对象包一层，undefined 记 null。 */
function resultObject(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { value: result ?? null };
}

/**
 * run.snapshot.status → 窗口处置。
 * Mastra restart 只接受 active 快照（running/waiting/pending，其余直接抛
 * "This workflow run was not active"）：suspended 只能走 resume；failed/
 * tripwire/bailed/canceled/paused 是终态——触发随之收敛为 failed（同键
 * 不再重跑，业务重试换幂等键即换新 trigger/run）。
 */
const RESTARTABLE_SNAPSHOT_STATUSES = new Set(["running", "waiting", "pending"]);
const TERMINAL_FAILURE_SNAPSHOT_STATUSES = new Set([
  "failed",
  "tripwire",
  "bailed",
  "canceled",
  "cancelled",
  "paused",
]);

export function createEmployeeTriggerRuntime(deps: {
  sessions: TriggerSessionManager;
  driver: EmployeeRunDriverFactory;
  /** 执行窗口 lease 时长；默认 60s。 */
  leaseTtlMs?: number;
  /** 时钟 seam（lease 判定写进 SQL 参数，测试可注入确定性时间）。 */
  now?: () => Date;
}): EmployeeTriggerRuntime {
  const handlers = new Map<string, TriggerHandler>();
  /** (database, employeeId) → 串行链尾：保证每员工同时只有一个执行窗口。 */
  const chains = new Map<string, Promise<unknown>>();
  let started = false;
  const leaseTtlMs = deps.leaseTtlMs ?? 60_000;
  const now = deps.now ?? (() => new Date());

  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(work);
    const tracked = next.catch(() => undefined);
    chains.set(key, tracked);
    return next.finally(() => {
      if (chains.get(key) === tracked) chains.delete(key);
    });
  }

  const keyOf = (database: string, employeeId: string) => `${database}::${employeeId}`;

  async function persistTrigger(
    session: TriggerSession,
    delivery: TriggerDelivery,
  ): Promise<TriggerRow | null> {
    const content: Record<string, unknown> = {
      employee: new StringRecordId(delivery.employeeId),
      reason: delivery.reason,
      chain_depth: delivery.chainDepth ?? 0,
      idempotency_key: delivery.idempotencyKey,
      status: "pending",
    };
    // option 字段不能绑 JS null（引擎把 null 当 NULL 而非 NONE）；无引用时整段省略。
    if (delivery.payloadRef !== undefined) content.payload_ref = delivery.payloadRef;
    const [rows] = await session.query<[TriggerRow[]]>(
      `INSERT INTO employee_trigger $content
       ON DUPLICATE KEY UPDATE idempotency_key = $input.idempotency_key
       RETURN AFTER;`,
      { content },
    );
    return rows?.[0] ?? null;
  }

  /**
   * 员工级窗口互斥（跨进程）：employee_window 行是"该员工正在跑"的占位。
   * employee 唯一索引 + UPSERT ... WHERE 构成单语句 CAS：行缺失 → 插入；
   * 行存在且租约到期/已释放（lease_expires_at IS NONE 或 <= now）→ 换 holder；
   * 活跃持有者 → WHERE 落空返回空。同员工第二个触发在活跃窗口期拿不到互斥行，
   * 保持 pending 由下次 reconcile/投递回收。
   * 注意不用 INSERT ... ON DUPLICATE KEY UPDATE 表达条件接管：RECORD 会话下
   * ON DUP 的未限定字段引用求值为 NONE（经真实库验证），条件恒真、等同无条件覆盖。
   * 返回 holder nonce = 赢；null = 被活跃窗口持有。
   */
  async function acquireWindow(
    session: TriggerSession,
    employeeId: string,
    triggerId: string,
  ): Promise<string | null> {
    const holder = crypto.randomUUID();
    const leaseExpires = new Date(now().getTime() + leaseTtlMs);
    try {
      const [rows] = await session.query<[unknown[]]>(
        `UPSERT employee_window SET
           employee = $employee,
           holder = $holder,
           trigger = $trigger,
           lease_expires_at = $leaseExpires
         WHERE employee = $employee
           AND (lease_expires_at IS NONE OR lease_expires_at <= $now)
         RETURN AFTER;`,
        {
          employee: new StringRecordId(employeeId),
          holder,
          trigger: new StringRecordId(triggerId),
          leaseExpires,
          now: now(),
        },
      );
      return rows && rows.length > 0 ? holder : null;
    } catch (err) {
      // 并发首个窗口：唯一索引冲突 = 对方持有，判负而非失败。
      if (isUniqueIndexConflict(err)) return null;
      throw err;
    }
  }

  /** 唯一索引冲突判定：SurrealDB 报 "Database index ... already contains ..."。 */
  function isUniqueIndexConflict(err: unknown): boolean {
    return err instanceof Error && /index.*already contains/i.test(err.message);
  }

  /** 释放窗口：只有仍持有该 holder 的窗口才清（防清掉后来者的新租约）。 */
  async function releaseWindow(
    session: TriggerSession,
    employeeId: string,
    holder: string,
  ): Promise<void> {
    await session.query(
      `UPDATE employee_window SET lease_expires_at = NONE, holder = NONE, trigger = NONE
       WHERE employee = $employee AND holder = $holder;`,
      { employee: new StringRecordId(employeeId), holder },
    );
  }

  /**
   * 原子认领：只有 pending（外加 extraStatuses）、或 leased|running 但 lease
   * 已到期/缺失的触发可进入本窗口。RETURN AFTER 为空 = lease 被活跃持有者
   * 占有 → 调用方收敛。
   */
  async function claimLease(
    session: TriggerSession,
    triggerId: string,
    extraStatuses: string[] = [],
  ): Promise<TriggerRow | null> {
    const allowed = ["pending", ...extraStatuses];
    const [rows] = await session.query<[TriggerRow[]]>(
      `UPDATE $trigger SET
         status = "leased",
         lease_expires_at = $leaseExpires,
         attempts = (attempts ?? 0) + 1,
         run_id = run_id ?? $runId
       WHERE status INSIDE $claimable
          OR (status INSIDE ["leased", "running"]
              AND (lease_expires_at = NONE OR lease_expires_at <= $now))
       RETURN AFTER;`,
      {
        trigger: new StringRecordId(triggerId),
        runId: `er-${triggerId}`,
        leaseExpires: new Date(now().getTime() + leaseTtlMs),
        now: now(),
        claimable: allowed,
      },
    );
    return rows?.[0] ?? null;
  }

  async function setStatus(
    session: TriggerSession,
    triggerId: string,
    status: "running" | "waiting" | "completed" | "failed",
    extra: { result?: unknown; message?: string } = {},
  ): Promise<void> {
    const assignments = ["status = $status"];
    const params: Record<string, unknown> = { trigger: new StringRecordId(triggerId), status };
    if (status === "running") assignments.push("started_at = time::now()", "error_message = NONE");
    if (status === "completed") {
      assignments.push("completed_at = time::now()", "error_message = NONE", "result = $result");
      params.result = resultObject(extra.result);
    }
    if (status === "waiting") assignments.push("error_message = NONE");
    if (status === "failed") {
      assignments.push("error_message = $message");
      params.message = extra.message ?? "unknown";
    }
    await session.query(`UPDATE $trigger SET ${assignments.join(", ")};`, params);
  }

  function envelopeOf(row: TriggerRow, delivery: {
    database: string;
    employeeId: string;
    reason: string;
    idempotencyKey: string;
  }): TriggerEnvelope {
    return {
      id: String(row.id),
      database: delivery.database,
      employeeId: delivery.employeeId,
      reason: delivery.reason,
      payloadRef: typeof row.payload_ref === "string" ? row.payload_ref : null,
      chainDepth: typeof row.chain_depth === "number" ? row.chain_depth : 0,
      idempotencyKey: delivery.idempotencyKey,
    };
  }

  /**
   * 已认领触发 → 驱动其 durable run 到终态/挂起态。
   * 快照缺失但 run_id 已分配 = 上次死在窗口早期，start 是唯一正确入口；
   * snapshot.status=running/failed → restart；suspended → waiting 收敛；
   * 终态 → 触发直接收敛。
   */
  async function driveRun(
    session: TriggerSession,
    row: TriggerRow,
    envelope: TriggerEnvelope,
  ): Promise<EnqueueResult> {
    const triggerId = String(row.id);
    const runId = typeof row.run_id === "string" && row.run_id ? row.run_id : `er-${triggerId}`;
    const driver = deps.driver({
      session,
      database: envelope.database,
      employeeId: envelope.employeeId,
      resolveHandler: (reason) => handlers.get(reason),
    });
    const state = await driver.loadRunState(runId);

    if (state && state.status === "suspended") {
      await setStatus(session, triggerId, "waiting");
      return { outcome: "waiting", triggerId };
    }
    if (state && (state.status === "success" || state.status === "done")) {
      const result = (state as { result?: unknown }).result;
      const output = result && typeof result === "object" && "output" in result
        ? (result as { output?: unknown }).output
        : result;
      await setStatus(session, triggerId, "completed", { result: output });
      return { outcome: "completed", triggerId };
    }
    if (state && TERMINAL_FAILURE_SNAPSHOT_STATUSES.has(state.status)) {
      // 终态 run 不可 restart：触发如实收敛为 failed（同键终态，adapter 换键重试）。
      const message = errorMessage(
        (state as { error?: unknown }).error ?? `run-${state.status}`,
      );
      await setStatus(session, triggerId, "failed", { message });
      return { outcome: "failed", triggerId, error: message };
    }

    await setStatus(session, triggerId, "running");
    const result = state === null
      ? await driver.start({ runId, trigger: envelope })
      : RESTARTABLE_SNAPSHOT_STATUSES.has(state.status)
        ? await driver.restart({ runId, trigger: envelope })
        : { status: "failed", error: `unsupported-snapshot-status:${state.status}` } satisfies EmployeeRunResult;

    if (result.status === "success") {
      await setStatus(session, triggerId, "completed", { result: result.output });
      return { outcome: "completed", triggerId };
    }
    if (result.status === "suspended") {
      await setStatus(session, triggerId, "waiting");
      return { outcome: "waiting", triggerId };
    }
    await setStatus(session, triggerId, "failed", { message: result.error });
    return { outcome: "failed", triggerId, error: result.error };
  }

  async function executeWindow(delivery: TriggerDelivery): Promise<EnqueueResult> {
    let session: TriggerSession;
    try {
      session = await deps.sessions.openSession(delivery.database, delivery.employeeId);
    } catch (cause) {
      // 员工暂停/退休或凭证缺失时连 SIGNIN 都过不去：触发不落库，返回失败由 adapter 决定。
      return { outcome: "failed", error: errorMessage(cause) };
    }
    let triggerId: string | undefined;
    try {
      const row = await persistTrigger(session, delivery);
      triggerId = row?.id == null ? undefined : String(row.id);
      if (!triggerId) throw new Error("employee-trigger-persist-failed");
      if (row?.status === "completed") return { outcome: "coalesced", triggerId };
      if (row?.status === "waiting") return { outcome: "waiting", triggerId };
      if (row?.status === "failed") {
        // failed 是同键终态：如实回报既有失败，不隐式重跑。
        const message = typeof row.error_message === "string" ? row.error_message : "trigger-failed";
        return { outcome: "failed", triggerId, error: message };
      }

      // 员工级互斥在触发租约之外：活跃窗口期同员工的其他触发保持 pending。
      const holder = await acquireWindow(session, delivery.employeeId, triggerId);
      if (!holder) return { outcome: "coalesced", triggerId };
      try {
        const claimed = await claimLease(session, triggerId);
        if (!claimed) return { outcome: "coalesced", triggerId };
        const envelope = envelopeOf(claimed, delivery);
        return await driveRun(session, claimed, envelope);
      } finally {
        await releaseWindow(session, delivery.employeeId, holder).catch(() => undefined);
      }
    } catch (cause) {
      // 基础设施异常（storage 读写失败、驱动崩溃、会话断开）：不打 failed——
      // 该行保留 leased/running 与 lease 到期时间，交给 reconcile/下次投递按
      // durable 语义回收。本窗口只如实上报这次尝试失败。
      const error = errorMessage(cause);
      console.error("[employee-trigger] window crashed", {
        database: delivery.database,
        employeeId: delivery.employeeId,
        reason: delivery.reason,
        idempotencyKey: delivery.idempotencyKey,
        triggerId,
        message: error,
      });
      return { outcome: "failed", ...(triggerId ? { triggerId } : {}), error };
    } finally {
      await deps.sessions.close(delivery.database, delivery.employeeId).catch(() => undefined);
    }
  }

  return {
    start() {
      started = true;
    },

    registerHandler(reason, handler) {
      handlers.set(reason, handler);
    },

    enqueue(delivery) {
      if (!started) return Promise.reject(new Error("employee-trigger-runtime-stopped"));
      return serialized(keyOf(delivery.database, delivery.employeeId), () => {
        if (!started) throw new Error("employee-trigger-runtime-stopped");
        return executeWindow(delivery);
      });
    },

    async reconcile({ database, employeeId }) {
      return serialized(keyOf(database, employeeId), async () => {
        const summary: ReconcileResult = { scanned: 0, reclaimed: 0, completed: 0, waiting: 0, failed: 0 };
        if (!started) return summary;
        let session: TriggerSession;
        try {
          session = await deps.sessions.openSession(database, employeeId);
        } catch {
          return summary;
        }
        try {
          const [rows] = await session.query<[TriggerRow[]]>(
            `SELECT id, status, payload_ref, chain_depth, reason, idempotency_key, run_id
             FROM employee_trigger
             WHERE employee = $employee
               AND (
                 status = "pending"
                 OR (status INSIDE ["leased", "running"]
                     AND (lease_expires_at = NONE OR lease_expires_at <= $now))
               );`,
            { employee: new StringRecordId(employeeId), now: now() },
          );
          summary.scanned = rows?.length ?? 0;
          for (const row of rows ?? []) {
            const triggerId = String(row.id);
            // 活跃窗口期互斥：本进程串行 + employee_window 跨进程守门。
            const holder = await acquireWindow(session, employeeId, triggerId);
            if (!holder) continue;
            try {
              const claimed = await claimLease(session, triggerId);
              if (!claimed) continue;
              summary.reclaimed += 1;
              const reason = typeof row.reason === "string" ? row.reason : "";
              const idempotencyKey = typeof row.idempotency_key === "string" ? row.idempotency_key : triggerId;
              const envelope = envelopeOf(claimed, { database, employeeId, reason, idempotencyKey });
              const outcome = await driveRun(session, claimed, envelope);
              if (outcome.outcome === "completed") summary.completed += 1;
              else if (outcome.outcome === "waiting") summary.waiting += 1;
              else summary.failed += 1;
            } finally {
              await releaseWindow(session, employeeId, holder).catch(() => undefined);
            }
          }
          return summary;
        } finally {
          await deps.sessions.close(database, employeeId).catch(() => undefined);
        }
      });
    },

    async resumeTrigger({ database, employeeId, triggerId, resumeData }) {
      return serialized(keyOf(database, employeeId), async (): Promise<EnqueueResult> => {
        if (!started) throw new Error("employee-trigger-runtime-stopped");
        let session: TriggerSession;
        try {
          session = await deps.sessions.openSession(database, employeeId);
        } catch (cause) {
          return { outcome: "failed", error: errorMessage(cause) };
        }
        try {
          const [rows] = await session.query<[TriggerRow[]]>(
            `SELECT id, status, payload_ref, chain_depth, reason, idempotency_key, run_id
             FROM $trigger WHERE employee = $employee;`,
            { trigger: new StringRecordId(triggerId), employee: new StringRecordId(employeeId) },
          );
          const row = rows?.[0];
          if (!row) return { outcome: "failed", triggerId, error: `trigger-not-found:${triggerId}` };
          if (row.status !== "waiting") {
            return { outcome: "failed", triggerId, error: `trigger-not-waiting:${String(row.status)}` };
          }
          // resume 也经窗口互斥 + lease：同一时刻只允许一个窗口碰这条触发。
          const holder = await acquireWindow(session, employeeId, triggerId);
          if (!holder) return { outcome: "coalesced", triggerId };
          try {
            const claimed = await claimLease(session, triggerId, ["waiting"]);
            if (!claimed) return { outcome: "coalesced", triggerId };
            const reason = typeof row.reason === "string" ? row.reason : "";
            const idempotencyKey = typeof row.idempotency_key === "string" ? row.idempotency_key : triggerId;
            const envelope = envelopeOf(claimed, { database, employeeId, reason, idempotencyKey });
            const runId = typeof claimed.run_id === "string" && claimed.run_id ? claimed.run_id : `er-${triggerId}`;
            const driver = deps.driver({
              session,
              database,
              employeeId,
              resolveHandler: (r) => handlers.get(r),
            });
            const state = await driver.loadRunState(runId);
            if (!state) {
              // 显式 suspended 的触发缺 snapshot = 持久层不一致，fail-closed。
              await setStatus(session, triggerId, "failed", { message: "snapshot-missing" });
              return { outcome: "failed", triggerId, error: "snapshot-missing" };
            }
            if (state.status !== "suspended") {
              return { outcome: "failed", triggerId, error: `run-not-suspended:${state.status}` };
            }
            await setStatus(session, triggerId, "running");
            const result = await driver.resume({ runId, trigger: envelope, resumeData });
            if (result.status === "success") {
              await setStatus(session, triggerId, "completed", { result: result.output });
              return { outcome: "completed", triggerId };
            }
            if (result.status === "suspended") {
              await setStatus(session, triggerId, "waiting");
              return { outcome: "waiting", triggerId };
            }
            await setStatus(session, triggerId, "failed", { message: result.error });
            return { outcome: "failed", triggerId, error: result.error };
          } finally {
            await releaseWindow(session, employeeId, holder).catch(() => undefined);
          }
        } catch (cause) {
          const error = errorMessage(cause);
          console.error("[employee-trigger] resume crashed", { database, employeeId, triggerId, message: error });
          return { outcome: "failed", triggerId, error };
        } finally {
          await deps.sessions.close(database, employeeId).catch(() => undefined);
        }
      });
    },

    async stop() {
      started = false;
      await Promise.allSettled([...chains.values()]);
    },
  };
}
