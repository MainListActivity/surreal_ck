import { StringRecordId } from "surrealdb";
import type { EmployeeEffects } from "./employee-effects";
import {
  createMeteredModel,
  createSurrealUsageMeter,
  defaultErrorClassifier,
  DEFAULT_GATE_LIMITS,
  DEFAULT_RETRY_POLICY,
  withBoundedRetry,
  type EmployeeUsageMeter,
  type ErrorClassifier,
  type GateLimits,
  type MeteredModel,
  type RetryPolicy,
  type RuntimeSignal,
  type RuntimeSignalEmitter,
} from "./employee-gates";

/**
 * 通用持久化触发 runtime（VER03 建立，VER04 加 lease/durable run/幂等副作用，
 * VER05 加预算、循环、重试与全局背压闸门）。
 *
 * - adapter 只负责把外部观察翻译成 TriggerDelivery（员工、原因、payload 引用、
 *   chain depth、幂等键）交给 enqueue()；runtime 负责 employee SIGNIN、把触发
 *   持久化到 workspace 内的 employee_trigger 表、经有 lease 的执行窗口驱动
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
 * - 一个员工同一时刻只有一个执行窗口：employee_window 行的 UPSERT CAS 是
 *   跨进程互斥；进程内同 (database, employeeId) 共用一条 lane——窗口按
 *   FIFO drain 该员工的 pending/过期触发，事件风暴下同一员工最多有
 *   「当前窗口 + 至多一个合并后的后续窗口」，不为每条触发各开窗口。
 * - 全局背压：进程级信号量限制同时在跑的执行窗口数；拿槽的窗口才有
 *   employee 会话，等待中的触发保持 pending 由 drain/回收接手。
 * - 闸门（详见 employee-gates）：每次模型调用经 ctx.model 计量闸门
 *   （窗口步数上限、按剩余额度压本次输出上限、provider usage/有界估算
 *   记账、同日同员工 budget-exhausted signal 只发一次）；级联触发经
 *   ctx.emit 投递、链深由 runtime 继承 parent+1 不可绕过；认领次数
 *   超 maxTriggerAttempts 转 failed + retry-exhausted signal；投递
 *   chainDepth 超 maxChainDepth 直接拒绝 + chain-depth-exceeded signal。
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
  /** 触发链深度；顶层观察为 0，级联触发由 runtime 继承递增（外部投递受上限约束）。 */
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
  /** 计量模型闸门：handler 内每次模型调用必经（预算/步数/重试/记账）。 */
  model: MeteredModel;
  /**
   * 级联投递：handler 产生后续触发时经此投递——链深强制 = 本触发
   * chainDepth + 1，调用方无法传入更小数字绕过上限；fire-and-forget
   * （同员工不等待执行，避免在串行 lane 内自锁）。
   */
  emit: CascadeEmit;
  /** 窗口限额视图：交给 Mastra agent 的 maxSteps / 循环条件的 iteration 上限。 */
  limits: GateLimits;
};

export type TriggerHandler = (ctx: TriggerHandlerContext) => Promise<unknown>;

/** ctx.emit 的入参：链深不在其中——由 runtime 从父触发继承 +1。 */
export type CascadeEmitInput = {
  reason: string;
  payloadRef?: string;
  idempotencyKey: string;
  /** 目标员工（同 workspace database 内）；缺省 = 当前触发员工。 */
  employeeId?: string;
};

export type CascadeEmitResult =
  | { accepted: true; triggerId: string; chainDepth: number }
  | {
      accepted: false;
      rejected: "chain-depth-exceeded" | "persist-failed";
      chainDepth?: number;
      error?: string;
    };

export type CascadeEmit = (input: CascadeEmitInput) => Promise<CascadeEmitResult>;

/** durable run 的终态视图（runtime 只关心这三态 + 失败原因）。 */
export type EmployeeRunResult =
  | { status: "success"; output: unknown }
  | { status: "suspended" }
  | { status: "failed"; error: string };

/** 窗口为单次触发执行准备的 handler 闸门（driver 注入 handler ctx）。 */
export type HandlerGates = {
  model: MeteredModel;
  emit: CascadeEmit;
  limits: GateLimits;
};

export type WindowGates = {
  /** 按触发信封生成 handler 闸门；窗口级计数器（步数）在底层共享。 */
  forTrigger(trigger: TriggerEnvelope): HandlerGates;
};

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
  /** 本窗口的 handler 闸门（budget/steps/limits/级联），按触发信封取。 */
  gates: WindowGates;
}) => EmployeeRunDriver;

export type EnqueueResult =
  | { outcome: "completed"; triggerId: string }
  /** 同一幂等键已由先前投递完成，或窗口/执行由别处接管：本次不重跑。 */
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
   * 订阅结构化 runtime signal（budget/depth/retry/step 超限）。业务 adapter
   * 在此决定如何通知用户；未订阅时信号只进结构化日志。
   */
  onSignal(emitter: RuntimeSignalEmitter): void;
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

/** 同 (database, employeeId) 的执行车道：会话、窗口调度、投递互斥都在这条 lane 上。 */
type LaneWaiter = {
  triggerId: string;
  settled: boolean;
  resolve: (result: EnqueueResult) => void;
};

type Lane = {
  database: string;
  employeeId: string;
  /** 窗口类任务（drain/reconcile/resume）的串行链尾。 */
  tail: Promise<void>;
  /** persist/会话开关的互斥链尾（防窗口 drain 期间会话被关闭/替换）。 */
  persistTail: Promise<unknown>;
  /** lane 当前持有的员工会话；由窗口/投递共享，lane 空闲时关闭。 */
  session?: TriggerSession;
  sessionOpening?: Promise<TriggerSession>;
  /** 已排队或正在运行的 drain 窗口：保证 ≤1 运行窗口 + ≤1 排队后续窗口。 */
  windowPlanned: boolean;
  /** 有 handler 级联投递进来：窗口结束时无论如何排一个后续窗口兜底。 */
  followupWanted: boolean;
  /** triggerId → 等待其终态的 enqueue 调用方。 */
  waiters: Map<string, LaneWaiter>;
};

export function createEmployeeTriggerRuntime(deps: {
  sessions: TriggerSessionManager;
  driver: EmployeeRunDriverFactory;
  /** 执行窗口 lease 时长；默认 60s。 */
  leaseTtlMs?: number;
  /** 时钟 seam（lease 判定写进 SQL 参数，测试可注入确定性时间）。 */
  now?: () => Date;
  /** 闸门限额覆盖（默认见 DEFAULT_GATE_LIMITS）。 */
  limits?: Partial<GateLimits>;
  /** 结构化 signal 出口；缺省为结构化日志。onSignal 订阅者额外收到。 */
  emitSignal?: RuntimeSignalEmitter;
  /** 每日 token 用量 seam；缺省走员工会话写 employee_token_usage。 */
  meter?: EmployeeUsageMeter;
  /** 错误分类器（transient/permanent）；缺省 defaultErrorClassifier。 */
  classifyError?: ErrorClassifier;
  /** 重试策略覆盖（maxAttempts/base/max/jitter）。 */
  retryPolicy?: Partial<RetryPolicy>;
  /** 退避 sleep seam（测试注入虚拟时钟）。 */
  sleep?: (ms: number) => Promise<void>;
}): EmployeeTriggerRuntime {
  const handlers = new Map<string, TriggerHandler>();
  const lanes = new Map<string, Lane>();
  const signalSubscribers: RuntimeSignalEmitter[] = [];
  let started = false;
  const leaseTtlMs = deps.leaseTtlMs ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const limits: GateLimits = { ...DEFAULT_GATE_LIMITS, ...deps.limits };
  const meter = deps.meter ?? createSurrealUsageMeter();
  const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...deps.retryPolicy };
  const classify = deps.classifyError ?? defaultErrorClassifier;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emitSignalDep = deps.emitSignal ?? defaultSignalLogger;

  // ── 进程级窗口并发信号量（全局背压上限）────────────────────────────────
  let activeWindows = 0;
  const windowQueue: Array<() => void> = [];
  function acquireWindowSlot(): Promise<() => void> {
    if (activeWindows < limits.maxConcurrentWindows) {
      activeWindows += 1;
      return Promise.resolve(releaseWindowSlot);
    }
    return new Promise((resolve) => {
      windowQueue.push(() => {
        activeWindows += 1;
        resolve(releaseWindowSlot);
      });
    });
  }
  function releaseWindowSlot(): void {
    activeWindows = Math.max(0, activeWindows - 1);
    windowQueue.shift()?.();
  }

  const keyOf = (database: string, employeeId: string) => `${database}::${employeeId}`;

  function laneOf(database: string, employeeId: string): Lane {
    const key = keyOf(database, employeeId);
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        database,
        employeeId,
        tail: Promise.resolve(),
        persistTail: Promise.resolve(),
        windowPlanned: false,
        followupWanted: false,
        waiters: new Map(),
      };
      lanes.set(key, lane);
    }
    return lane;
  }

  function defaultSignalLogger(signal: RuntimeSignal): void {
    console.warn("[employee-trigger] runtime-signal", JSON.stringify(signal));
  }

  /** 信号出口：dep emitter + 全部订阅者，逐个隔离异常不阻断闸门判定。 */
  async function emitRuntimeSignal(
    signal: Omit<RuntimeSignal, "at"> & { at?: Date },
  ): Promise<void> {
    const full: RuntimeSignal = { ...signal, at: signal.at ?? now() };
    for (const emit of [emitSignalDep, ...signalSubscribers]) {
      try {
        await emit(full);
      } catch (cause) {
        console.warn("[employee-trigger] signal emit failed", {
          kind: full.kind,
          message: errorMessage(cause),
        });
      }
    }
  }

  // ── lane 内 persist/会话互斥 ────────────────────────────────────────────

  function inPersist<T>(lane: Lane, work: (lane: Lane) => Promise<T> | T): Promise<T> {
    const next = lane.persistTail.then(() => work(lane));
    lane.persistTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** lane 会话：窗口与投递共享同一条；openSession 带 transient 重试。 */
  async function ensureLaneSession(lane: Lane): Promise<TriggerSession> {
    if (lane.session) return lane.session;
    lane.sessionOpening ??= withBoundedRetry(
      () => deps.sessions.openSession(lane.database, lane.employeeId),
      { policy: retryPolicy, classify, sleep },
    )
      .then((session) => {
        lane.session = session;
        return session;
      })
      .finally(() => {
        lane.sessionOpening = undefined;
      });
    return lane.sessionOpening;
  }

  async function closeLaneSession(lane: Lane): Promise<void> {
    const session = lane.session;
    lane.session = undefined;
    if (session) await deps.sessions.close(lane.database, lane.employeeId).catch(() => undefined);
  }

  // ── waiter 结算 ─────────────────────────────────────────────────────────

  function settleWaiter(lane: Lane, triggerId: string, result: EnqueueResult): void {
    const waiter = lane.waiters.get(triggerId);
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    lane.waiters.delete(triggerId);
    waiter.resolve(result);
  }

  function settleAllWaiters(lane: Lane, outcome: "coalesced" | "failed", error?: string): void {
    for (const waiter of [...lane.waiters.values()]) {
      if (waiter.settled) continue;
      waiter.settled = true;
      lane.waiters.delete(waiter.triggerId);
      waiter.resolve(
        outcome === "coalesced"
          ? { outcome: "coalesced", triggerId: waiter.triggerId }
          : { outcome: "failed", triggerId: waiter.triggerId, error: error ?? "unknown" },
      );
    }
  }

  function hasUnsettledWaiters(lane: Lane): boolean {
    for (const waiter of lane.waiters.values()) if (!waiter.settled) return true;
    return false;
  }

  /**
   * 窗口结束清扫：仍为终态未决的 waiter 按其触发行状态结算——
   * 终态如实回报；pending 留给后续窗口；leased/running/缺失 = 别处接管或异常。
   */
  async function sweepWaiters(lane: Lane, session: TriggerSession): Promise<void> {
    for (const waiter of [...lane.waiters.values()]) {
      if (waiter.settled) continue;
      try {
        const [rows] = await session.query<[TriggerRow[]]>(
          `SELECT id, status, error_message FROM $trigger;`,
          { trigger: new StringRecordId(waiter.triggerId) },
        );
        const row = rows?.[0];
        const status = row ? String(row.status) : "missing";
        if (status === "completed") {
          settleWaiter(lane, waiter.triggerId, { outcome: "completed", triggerId: waiter.triggerId });
        } else if (status === "failed") {
          settleWaiter(lane, waiter.triggerId, {
            outcome: "failed",
            triggerId: waiter.triggerId,
            error: typeof row?.error_message === "string" ? row.error_message : "trigger-failed",
          });
        } else if (status === "waiting") {
          settleWaiter(lane, waiter.triggerId, { outcome: "waiting", triggerId: waiter.triggerId });
        } else if (status === "pending") {
          // 仍在队列里：留给本 lane 的后续窗口（housekeeping 会排）。
        } else {
          settleWaiter(lane, waiter.triggerId, { outcome: "coalesced", triggerId: waiter.triggerId });
        }
      } catch {
        // 查询失败不结算；housekeeping 若仍见其未决会再排窗口，stop 兜底。
      }
    }
  }

  // ── 窗口调度与收尾 ──────────────────────────────────────────────────────

  function scheduleWindow(lane: Lane): void {
    if (!started || lane.windowPlanned) return;
    lane.windowPlanned = true;
    lane.tail = lane.tail.then(() => runWindow(lane));
  }

  /** 任意窗口类任务排到 lane 串行链尾（drain/reconcile/resume 共用互斥）。 */
  function laneTask<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
    const next = lane.tail.then(work);
    lane.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 窗口/任务收尾：若仍有未决 waiter 或 handler 级联投递过，排一个后续窗口；
   * lane 彻底空闲则释放员工会话。统一在 persistTail 互斥内判定。
   */
  async function housekeeping(lane: Lane): Promise<void> {
    await inPersist(lane, async () => {
      if (!started) settleAllWaiters(lane, "failed", "employee-trigger-runtime-stopped");
      const needFollowup = started && (hasUnsettledWaiters(lane) || lane.followupWanted);
      lane.followupWanted = false;
      if (needFollowup) {
        scheduleWindow(lane);
        return;
      }
      if (!lane.windowPlanned) await closeLaneSession(lane);
    });
  }

  // ── 触发持久化与窗口互斥 ────────────────────────────────────────────────

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
   * 活跃持有者 → WHERE 落空返回空。拿不到互斥行的 lane 不启动 drain。
   * 返回 holder nonce = 赢；null = 被活跃窗口持有。
   */
  async function acquireWindow(
    session: TriggerSession,
    employeeId: string,
  ): Promise<string | null> {
    const holder = crypto.randomUUID();
    const leaseExpires = new Date(now().getTime() + leaseTtlMs);
    try {
      const [rows] = await session.query<[unknown[]]>(
        `UPSERT employee_window SET
           employee = $employee,
           holder = $holder,
           trigger = NONE,
           lease_expires_at = $leaseExpires
         WHERE employee = $employee
           AND (lease_expires_at IS NONE OR lease_expires_at <= $now)
         RETURN AFTER;`,
        {
          employee: new StringRecordId(employeeId),
          holder,
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

  /** 观测位：窗口当前正在驱动的触发（不影响互斥语义）。 */
  async function markWindowTrigger(
    session: TriggerSession,
    employeeId: string,
    holder: string,
    triggerId: string,
  ): Promise<void> {
    try {
      await session.query(
        `UPDATE employee_window SET trigger = $trigger, updated_at = time::now()
         WHERE employee = $employee AND holder = $holder;`,
        { employee: new StringRecordId(employeeId), holder, trigger: new StringRecordId(triggerId) },
      );
    } catch {
      // 观测位失败不影响互斥
    }
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

  /** drain 取件：按 created_at FIFO 找最早可认领触发并原子认领；撞车重找。 */
  async function claimNextPending(session: TriggerSession, lane: Lane): Promise<TriggerRow | null> {
    for (let round = 0; round < 8; round += 1) {
      const [rows] = await session.query<[TriggerRow[]]>(
        `SELECT id, created_at FROM employee_trigger
         WHERE employee = $employee
           AND (status = "pending"
                OR (status INSIDE ["leased", "running"]
                    AND (lease_expires_at = NONE OR lease_expires_at <= $now)))
         ORDER BY created_at ASC LIMIT 1;`,
        { employee: new StringRecordId(lane.employeeId), now: now() },
      );
      const candidate = rows?.[0];
      if (!candidate) return null;
      const claimed = await claimLease(session, String(candidate.id));
      if (claimed) return claimed;
    }
    return null;
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

  // ── handler 闸门 ────────────────────────────────────────────────────────

  function gatesFor(lane: Lane, session: TriggerSession, steps: { count: number }): WindowGates {
    return {
      forTrigger(trigger) {
        return {
          limits,
          model: createMeteredModel({
            session,
            database: lane.database,
            employeeId: lane.employeeId,
            triggerId: trigger.id,
            reason: trigger.reason,
            limits,
            meter,
            emitSignal: (partial) =>
              emitRuntimeSignal({ ...partial, database: lane.database, employeeId: lane.employeeId }),
            now,
            steps,
            retry: { policy: retryPolicy, classify, sleep },
          }),
          emit: (input) => emitCascade(lane, trigger, input),
        };
      },
    };
  }

  /**
   * 级联投递：链深 = 父触发 chainDepth + 1（从持久化行读，不接受调用方传值）。
   * fire-and-forget：同员工投递只落库 + 置 followupWanted，由本 lane 的
   * drain/后续窗口拾取；跨员工投递额外调度目标 lane。绝不在此等待执行——
   * 否则同员工 lane 内自锁。
   */
  async function emitCascade(
    lane: Lane,
    parent: TriggerEnvelope,
    input: CascadeEmitInput,
  ): Promise<CascadeEmitResult> {
    const depth = parent.chainDepth + 1;
    const targetEmployee = input.employeeId ?? parent.employeeId;
    if (depth > limits.maxChainDepth) {
      await emitRuntimeSignal({
        kind: "chain-depth-exceeded",
        database: lane.database,
        employeeId: parent.employeeId,
        triggerId: parent.id,
        reason: input.reason,
        detail: {
          parentTriggerId: parent.id,
          parentDepth: parent.chainDepth,
          attemptedDepth: depth,
          max: limits.maxChainDepth,
          childReason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { accepted: false, rejected: "chain-depth-exceeded", chainDepth: depth };
    }
    let row: TriggerRow | null;
    try {
      row = await inPersist(lane, async (l) =>
        persistTrigger(await ensureLaneSession(l), {
          database: lane.database,
          employeeId: targetEmployee,
          reason: input.reason,
          payloadRef: input.payloadRef,
          chainDepth: depth,
          idempotencyKey: input.idempotencyKey,
        }),
      );
    } catch (cause) {
      return { accepted: false, rejected: "persist-failed", error: errorMessage(cause) };
    }
    const triggerId = row?.id == null ? undefined : String(row.id);
    if (!triggerId) {
      return { accepted: false, rejected: "persist-failed", error: "employee-trigger-persist-failed" };
    }
    if (targetEmployee === lane.employeeId) {
      lane.followupWanted = true;
    } else {
      scheduleWindow(laneOf(lane.database, targetEmployee));
    }
    return { accepted: true, triggerId, chainDepth: depth };
  }

  // ── run 驱动与窗口主体 ──────────────────────────────────────────────────

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
    lane: Lane,
    steps: { count: number },
  ): Promise<EnqueueResult> {
    const triggerId = String(row.id);
    const runId = typeof row.run_id === "string" && row.run_id ? row.run_id : `er-${triggerId}`;
    const driver = deps.driver({
      session,
      database: envelope.database,
      employeeId: envelope.employeeId,
      resolveHandler: (reason) => handlers.get(reason),
      gates: gatesFor(lane, session, steps),
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

  /** 认领数超上限：同键终态 failed + retry-exhausted signal。返回 true 表示已按终态处理。 */
  async function exhaustAttempts(
    lane: Lane,
    session: TriggerSession,
    claimed: TriggerRow,
  ): Promise<boolean> {
    const attempts = typeof claimed.attempts === "number" ? claimed.attempts : 0;
    if (attempts <= limits.maxTriggerAttempts) return false;
    const triggerId = String(claimed.id);
    const message = `attempts-exhausted:${attempts}>${limits.maxTriggerAttempts}`;
    await setStatus(session, triggerId, "failed", { message }).catch(() => undefined);
    await emitRuntimeSignal({
      kind: "retry-exhausted",
      database: lane.database,
      employeeId: lane.employeeId,
      triggerId,
      reason: typeof claimed.reason === "string" ? claimed.reason : undefined,
      detail: { attempts, max: limits.maxTriggerAttempts },
    });
    settleWaiter(lane, triggerId, { outcome: "failed", triggerId, error: message });
    return true;
  }

  /**
   * drain 窗口：全局信号量槽位 → 员工互斥行 → FIFO 认领驱动触发，
   * 直到排空、步数截断（maxTriggersPerWindow）或进程停闸。
   */
  async function runWindow(lane: Lane): Promise<void> {
    const release = await acquireWindowSlot();
    try {
      if (!started) return;
      let session: TriggerSession;
      try {
        session = await inPersist(lane, () => ensureLaneSession(lane));
      } catch (cause) {
        settleAllWaiters(lane, "failed", errorMessage(cause));
        return;
      }
      let holder: string | null;
      try {
        holder = await acquireWindow(session, lane.employeeId);
      } catch (cause) {
        settleAllWaiters(lane, "failed", errorMessage(cause));
        return;
      }
      if (!holder) {
        // 别进程持有活跃窗口：本 lane 的触发留在 pending 由其 drain/回收接手。
        settleAllWaiters(lane, "coalesced");
        return;
      }
      try {
        const steps = { count: 0 };
        let processed = 0;
        while (started && processed < limits.maxTriggersPerWindow) {
          let claimed: TriggerRow | null;
          try {
            claimed = await claimNextPending(session, lane);
          } catch (cause) {
            // 取件本身故障（会话断开/存储异常）= 窗口级崩溃：行保持 pending，
            // waiter 如实失败，交给下投递或 reconcile 重启窗口。
            const error = errorMessage(cause);
            console.error("[employee-trigger] window crashed", {
              database: lane.database,
              employeeId: lane.employeeId,
              message: error,
            });
            settleAllWaiters(lane, "failed", error);
            return;
          }
          if (!claimed) break;
          processed += 1;
          const triggerId = String(claimed.id);
          await markWindowTrigger(session, lane.employeeId, holder, triggerId);
          const reason = typeof claimed.reason === "string" ? claimed.reason : "";
          const idempotencyKey =
            typeof claimed.idempotency_key === "string" ? claimed.idempotency_key : triggerId;
          const envelope = envelopeOf(claimed, {
            database: lane.database,
            employeeId: lane.employeeId,
            reason,
            idempotencyKey,
          });
          if (await exhaustAttempts(lane, session, claimed)) continue;
          try {
            const outcome = await driveRun(session, claimed, envelope, lane, steps);
            settleWaiter(lane, triggerId, outcome);
          } catch (cause) {
            // 基础设施异常（storage 读写失败、驱动崩溃、会话断开）：不打 failed——
            // 该行保留 leased/running 与 lease 到期时间，交给 reconcile/下次投递
            // 按 durable 语义回收。本窗口如实上报这次尝试失败并停止 drain。
            const error = errorMessage(cause);
            console.error("[employee-trigger] window crashed", {
              database: lane.database,
              employeeId: lane.employeeId,
              reason,
              idempotencyKey,
              triggerId,
              message: error,
            });
            settleWaiter(lane, triggerId, { outcome: "failed", triggerId, error });
            break;
          }
        }
        await sweepWaiters(lane, session);
      } catch (cause) {
        // drain 中其余基础设施异常（标记/收尾读写失败）：waiter 一律如实失败，
        // 触发保留 lease 供 reconcile 回收，互斥行由 finally 释放。
        const error = errorMessage(cause);
        console.error("[employee-trigger] window crashed", {
          database: lane.database,
          employeeId: lane.employeeId,
          message: error,
        });
        settleAllWaiters(lane, "failed", error);
      } finally {
        await releaseWindow(session, lane.employeeId, holder).catch(() => undefined);
      }
    } finally {
      release();
      lane.windowPlanned = false;
      await housekeeping(lane);
    }
  }

  return {
    start() {
      started = true;
    },

    registerHandler(reason, handler) {
      handlers.set(reason, handler);
    },

    async enqueue(delivery) {
      if (!started) throw new Error("employee-trigger-runtime-stopped");
      const depth = delivery.chainDepth ?? 0;
      if (depth > limits.maxChainDepth) {
        await emitRuntimeSignal({
          kind: "chain-depth-exceeded",
          database: delivery.database,
          employeeId: delivery.employeeId,
          reason: delivery.reason,
          detail: {
            chainDepth: depth,
            max: limits.maxChainDepth,
            idempotencyKey: delivery.idempotencyKey,
          },
        });
        return { outcome: "failed", error: `chain-depth-exceeded:${depth}>${limits.maxChainDepth}` };
      }
      const lane = laneOf(delivery.database, delivery.employeeId);
      let row: TriggerRow | null;
      try {
        row = await inPersist(lane, async (l) =>
          persistTrigger(await ensureLaneSession(l), delivery),
        );
      } catch (cause) {
        // 员工暂停/退休或凭证缺失时连 SIGNIN 都过不去：触发不落库，返回失败由 adapter 决定。
        return { outcome: "failed", error: errorMessage(cause) };
      }
      const triggerId = row?.id == null ? undefined : String(row.id);
      if (!triggerId) return { outcome: "failed", error: "employee-trigger-persist-failed" };
      if (row?.status === "completed") {
        await housekeeping(lane);
        return { outcome: "coalesced", triggerId };
      }
      if (row?.status === "waiting") {
        await housekeeping(lane);
        return { outcome: "waiting", triggerId };
      }
      if (row?.status === "failed") {
        // failed 是同键终态：如实回报既有失败，不隐式重跑。
        await housekeeping(lane);
        const message = typeof row.error_message === "string" ? row.error_message : "trigger-failed";
        return { outcome: "failed", triggerId, error: message };
      }

      const waiter: LaneWaiter = {
        triggerId,
        settled: false,
        resolve: () => undefined,
      };
      const promise = new Promise<EnqueueResult>((resolve) => {
        waiter.resolve = resolve;
      });
      lane.waiters.set(triggerId, waiter);
      scheduleWindow(lane);
      return promise;
    },

    async reconcile({ database, employeeId }) {
      const lane = laneOf(database, employeeId);
      return laneTask(lane, async (): Promise<ReconcileResult> => {
        const summary: ReconcileResult = { scanned: 0, reclaimed: 0, completed: 0, waiting: 0, failed: 0 };
        if (!started) return summary;
        let session: TriggerSession;
        try {
          session = await inPersist(lane, () => ensureLaneSession(lane));
        } catch {
          return summary;
        }
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
        if (!rows || rows.length === 0) {
          await housekeeping(lane);
          return summary;
        }
        const release = await acquireWindowSlot();
        try {
          // 活跃窗口期互斥：本进程串行 + employee_window 跨进程守门。
          const holder = await acquireWindow(session, employeeId).catch(() => null);
          if (!holder) {
            await housekeeping(lane);
            return summary;
          }
          try {
            const steps = { count: 0 };
            for (const row of rows) {
              if (!started) break;
              const triggerId = String(row.id);
              const claimed = await claimLease(session, triggerId);
              if (!claimed) continue;
              summary.reclaimed += 1;
              await markWindowTrigger(session, employeeId, holder, triggerId);
              if (await exhaustAttempts(lane, session, claimed)) {
                summary.failed += 1;
                continue;
              }
              const reason = typeof claimed.reason === "string" ? claimed.reason : "";
              const idempotencyKey =
                typeof claimed.idempotency_key === "string" ? claimed.idempotency_key : triggerId;
              const envelope = envelopeOf(claimed, { database, employeeId, reason, idempotencyKey });
              try {
                const outcome = await driveRun(session, claimed, envelope, lane, steps);
                if (outcome.outcome === "completed") summary.completed += 1;
                else if (outcome.outcome === "waiting") summary.waiting += 1;
                else summary.failed += 1;
                settleWaiter(lane, triggerId, outcome);
              } catch (cause) {
                summary.failed += 1;
                settleWaiter(lane, triggerId, {
                  outcome: "failed",
                  triggerId,
                  error: errorMessage(cause),
                });
                break;
              }
            }
            await sweepWaiters(lane, session);
          } finally {
            await releaseWindow(session, employeeId, holder).catch(() => undefined);
          }
        } finally {
          release();
          await housekeeping(lane);
        }
        return summary;
      });
    },

    async resumeTrigger({ database, employeeId, triggerId, resumeData }) {
      const lane = laneOf(database, employeeId);
      return laneTask(lane, async (): Promise<EnqueueResult> => {
        if (!started) throw new Error("employee-trigger-runtime-stopped");
        let session: TriggerSession;
        try {
          session = await inPersist(lane, () => ensureLaneSession(lane));
        } catch (cause) {
          return { outcome: "failed", error: errorMessage(cause) };
        }
        let release: (() => void) | null = null;
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
          release = await acquireWindowSlot();
          // resume 也经窗口互斥 + lease：同一时刻只允许一个窗口碰这条触发。
          const holder = await acquireWindow(session, employeeId);
          if (!holder) return { outcome: "coalesced", triggerId };
          try {
            const claimed = await claimLease(session, triggerId, ["waiting"]);
            if (!claimed) return { outcome: "coalesced", triggerId };
            if (await exhaustAttempts(lane, session, claimed)) {
              return { outcome: "failed", triggerId, error: "attempts-exhausted" };
            }
            await markWindowTrigger(session, employeeId, holder, triggerId);
            const reason = typeof claimed.reason === "string" ? claimed.reason : "";
            const idempotencyKey =
              typeof claimed.idempotency_key === "string" ? claimed.idempotency_key : triggerId;
            const envelope = envelopeOf(claimed, { database, employeeId, reason, idempotencyKey });
            const runId =
              typeof claimed.run_id === "string" && claimed.run_id ? claimed.run_id : `er-${triggerId}`;
            const driver = deps.driver({
              session,
              database,
              employeeId,
              resolveHandler: (r) => handlers.get(r),
              gates: gatesFor(lane, session, { count: 0 }),
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
          release?.();
          await housekeeping(lane);
        }
      });
    },

    onSignal(emitter) {
      signalSubscribers.push(emitter);
    },

    async stop() {
      started = false;
      for (const lane of lanes.values()) {
        settleAllWaiters(lane, "failed", "employee-trigger-runtime-stopped");
      }
      // 等在途窗口排空（drain 循环在每条边界检查 started，跑完当前触发即退出）。
      await Promise.allSettled([...lanes.values()].map((lane) => lane.tail));
      for (const lane of lanes.values()) {
        await inPersist(lane, () => closeLaneSession(lane)).catch(() => undefined);
      }
      lanes.clear();
    },
  };
}
