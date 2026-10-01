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
 * - 窗口有界收敛（D1 返工）：窗口按 abort 收敛，三个来源共用同一条路径——
 *   ① stop() 到点关停（"window-aborted"）；② 看门狗（窗口超过
 *   windowDeadlineMs，缺省 leaseTtlMs + 5s 宽限，VER04 lease 语义：窗口
 *   超过自己租约即按孤儿处理，触发清回可回收态，游离 driveRun 的写库
 *   结果如实落库）→ "window-lease-expired"；③ 生命周期关闭会话
 *   （pause/retire 的 sessions close 经 invalidateSession 同步通知）→
 *   "employee-session-closed"。abort 后窗口 finally 必跑：windowPlanned
 *   复位、waiter 按归一化错误码结算、lane 会话缓存交 housekeeping 清理，
 *   不存在「悬挂窗口卡死 lane」的状态（VER 联验 D1 缺陷的根因即此）。
 * - lane 会话缓存失效（D1 返工）：生命周期 close/register 替换会话时，
 *   会话管理器同步回调 invalidateSession，lane 立即丢弃旧会话对象——
 *   ensureLaneSession 绝不复用已关闭/已失效的会话；resume 后的下一个
 *   窗口以全新代次建立会话并正常投递。pause 中投递：SIGNIN 被员工
 *   access 拒绝，保持快速 failed("employee-session-blocked") 不落库。
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

/** 连接层观测计数（生产由 EmployeeRuntime.sessionStats() 提供）；只含计数，无凭证。 */
export type SessionManagerStats = {
  activeSessions: number;
  connects: number;
  reconnects: number;
  disconnects: number;
  renewals: number;
  renewalFailures: number;
  invalidated: number;
};

/** 会话来源 seam：生产是 EmployeeRuntime，测试注入替身。 */
export type TriggerSessionManager = {
  openSession(database: string, employeeId: string): Promise<TriggerSession>;
  close(database: string, employeeId: string): Promise<void>;
  /** 可选：连接监督计数（重连/续约/断开），runtime.metrics() 聚合上报。 */
  sessionStats?(): SessionManagerStats;
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
  /** 认领时绑定的 durable run id（er-<triggerId>）；handler 可用它做 run 关联追溯。 */
  runId: string | null;
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
  /**
   * 关停到点中止：生产实现调用 Mastra run.cancel()（snapshot 落 canceled），
   * 之后 reconcile 按终态把触发收敛为 failed。可选；缺失时窗口只靠
   * lease 到期/下次扫描回收。
   */
  abort?(): void | Promise<void>;
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

/**
 * 运行时健康/容量指标快照（VER06）：只有计数、时间戳与毫秒数，
 * 绝不含 secret/token/payload。pendingApprox 是进程内观测近似值
 * （新增 pending +1、本进程认领 -1、重启后由 reconcile 扫描校准），
 * 精确 pending 数以员工会话查库为准。
 */
export type EmployeeRuntimeMetrics = {
  started: boolean;
  startedAt: string | null;
  uptimeMs: number;
  sessions: {
    open: number;
    openRetries: number;
    openFailures: number;
  };
  windows: {
    running: number;
    queued: number;
    completed: number;
    crashed: number;
    aborted: number;
  };
  triggers: {
    enqueued: number;
    coalesced: number;
    pendingApprox: number;
    running: number;
    completed: number;
    failed: number;
    waiting: number;
  };
  /** 有界重试总次数（会话打开 + 模型调用）。 */
  retries: number;
  tokenUsage: {
    providerInputTokens: number;
    providerOutputTokens: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    calls: number;
  };
  /** 执行窗口 lease 观测：当前活跃窗口数与最老窗口已持有时长。 */
  lease: {
    activeWindows: number;
    oldestWindowAgeMs: number | null;
  };
  /** 连接监督计数（来自会话管理器；缺省会话源时为全零）。 */
  connections: SessionManagerStats;
  reconcile: {
    runs: number;
    scanned: number;
    reclaimed: number;
    lastRunAt: string | null;
  };
  shutdown: {
    runs: number;
    timedOut: boolean;
    abortedWindows: number;
    durationMs: number | null;
  };
  signals: number;
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
   *
   * VER06 起限时：先停收（enqueue 立即拒绝、waiter 如实失败），再等
   * deadlineMs 内的窗口排空；到点仍未排空的窗口收到 abort（driver.abort
   * → Mastra run.cancel），触发 lease 被清回可立即回收态，窗口 lease
   * 由 finally 正常释放；再过 abortGraceMs 宽限后强制收尾——过程不会
   * 无限等待。deadlineMs 缺省用 deps.shutdownDeadlineMs（默认 30s）。
   */
  stop(options?: { deadlineMs?: number }): Promise<void>;
  /**
   * 会话失效通知（D1 返工）：会话管理器在生命周期关闭/替换员工会话时
   * 同步调用。lane 立即丢弃缓存的会话对象（ensureLaneSession 绝不复用
   * 死会话），在途窗口经 abort 收敛路径有界结束（waiter 结算为
   * failed("employee-session-closed")，触发清回可回收态）。同步执行、
   * 不 await 任何关闭动作，避免与 persist 互斥链互等。
   */
  invalidateSession(input: { database: string; employeeId: string }): void;
  /** 健康/容量指标快照：纯进程内计数 + 时间戳，无 secret/token/payload。 */
  metrics(): EmployeeRuntimeMetrics;
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

/**
 * waiter/投递失败的归一化（D1 返工）：已知运行时错误码原样通过；SDK /
 * 存储层的原始错误串不进入 EnqueueResult（诊断端点据此不再透出裸串），
 * 原始信息只进服务端日志。会话层失效统一归为 "employee-session-closed"。
 */
const KNOWN_DELIVERY_ERROR_CODES = new Set([
  "employee-session-blocked",
  "employee-session-closed",
  "employee-session-unavailable",
  "employee-signin-failed",
  "employee-credential-missing",
  "employee-runtime-stopped",
  "employee-trigger-persist-failed",
  "employee-delivery-failed",
  "window-aborted",
  "window-lease-expired",
  "snapshot-missing",
  "trigger-failed",
  "attempts-exhausted",
]);
const KNOWN_DELIVERY_ERROR_PREFIXES = [
  "chain-depth-exceeded:",
  "trigger-not-found:",
  "trigger-not-waiting:",
  "run-not-suspended:",
  "unsupported-snapshot-status:",
  "attempts-exhausted:",
];

export function normalizeDeliveryError(message: string): string {
  if (KNOWN_DELIVERY_ERROR_CODES.has(message)) return message;
  if (KNOWN_DELIVERY_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) return message;
  console.warn("[employee-trigger] delivery error normalized", { message });
  return "employee-session-closed";
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

/**
 * 窗口中止原因 = waiter 结算用的归一化错误码（诊断端点只透出这些码，
 * 不透出 SDK 原始错误串）：
 * - "window-aborted"：stop() 关停到点；
 * - "window-lease-expired"：窗口超过自身 lease 的看门狗到点（孤儿窗口）；
 * - "employee-session-closed"：生命周期关闭/替换会话（pause/retire/resume
 *   换代次）使在途窗口失去执行载体。
 */
export type WindowAbortReason = "window-aborted" | "window-lease-expired" | "employee-session-closed";

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
  /** 当前在途窗口的中止开关（窗口期间设置；stop 到点后触发）。 */
  windowAbort?: AbortController;
  /** 本窗口的中止原因（abortWindow 设置；waiter 结算用）。 */
  windowAbortReason?: WindowAbortReason;
  /** 当前窗口开始时间戳（lease age 指标）。 */
  windowStartedAt?: number;
  /** triggerId → 等待其终态的 enqueue 调用方。 */
  waiters: Map<string, LaneWaiter>;
};

export function createEmployeeTriggerRuntime(deps: {
  sessions: TriggerSessionManager;
  driver: EmployeeRunDriverFactory;
  /** 执行窗口 lease 时长；默认 60s。 */
  leaseTtlMs?: number;
  /**
   * 执行窗口硬截止（毫秒）：窗口单次触发的 driving 超过此时限由看门狗
   * abort 收敛（waiter 结算 failed("window-lease-expired")，触发清回可
   * 回收态，游离 driveRun 的写库结果如实落库）。缺省 leaseTtlMs + 5s
   * 宽限；每次触发结算后重新武装。D1 返工：保证 pause 等会话失效落在
   * 窗口内时 lane 有界收敛，不依赖 SDK 对死会话的报错行为。
   */
  windowDeadlineMs?: number;
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
  /** stop() 的默认截止时间（毫秒）；stop(options.deadlineMs) 优先。默认 30s。 */
  shutdownDeadlineMs?: number;
  /** 到点 abort 后等待窗口收尾的宽限（毫秒）；默认 5s。 */
  abortGraceMs?: number;
}): EmployeeTriggerRuntime {
  const handlers = new Map<string, TriggerHandler>();
  const lanes = new Map<string, Lane>();
  const signalSubscribers: RuntimeSignalEmitter[] = [];
  let started = false;
  let stopping: Promise<void> | null = null;
  const leaseTtlMs = deps.leaseTtlMs ?? 60_000;
  const windowDeadlineMs = deps.windowDeadlineMs ?? leaseTtlMs + 5_000;
  const shutdownDeadlineMs = deps.shutdownDeadlineMs ?? 30_000;
  const abortGraceMs = deps.abortGraceMs ?? 5_000;
  const now = deps.now ?? (() => new Date());
  const limits: GateLimits = { ...DEFAULT_GATE_LIMITS, ...deps.limits };
  const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...deps.retryPolicy };
  const classify = deps.classifyError ?? defaultErrorClassifier;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emitSignalDep = deps.emitSignal ?? defaultSignalLogger;

  // ── 指标收集（VER06）：纯内存计数，快照由 metrics() 组装 ────────────────
  const metricsState = {
    startedAt: null as Date | null,
    sessionOpenRetries: 0,
    sessionOpenFailures: 0,
    windows: { completed: 0, crashed: 0, aborted: 0 },
    triggers: { enqueued: 0, coalesced: 0, pendingApprox: 0, completed: 0, failed: 0, waiting: 0 },
    retries: 0,
    tokenUsage: { providerIn: 0, providerOut: 0, estIn: 0, estOut: 0, calls: 0 },
    reconcile: { runs: 0, scanned: 0, reclaimed: 0, lastRunAt: null as string | null },
    shutdowns: [] as Array<{ at: string; durationMs: number; timedOut: boolean; abortedWindows: number }>,
    signals: 0,
  };
  /** 本进程标记 running 的触发集合：供 running 计数在终态转换时精确归零。 */
  const runningTriggers = new Set<string>();

  /** 计量包装：在原有 meter 之上累计进程内 token 总量供 metrics() 上报。 */
  const baseMeter = deps.meter ?? createSurrealUsageMeter();
  const meter: EmployeeUsageMeter = {
    usedTokens: (s, e, d) => baseMeter.usedTokens(s, e, d),
    claimBudgetSignal: (s, e, d) => baseMeter.claimBudgetSignal(s, e, d),
    async recordUsage(session, employeeId, day, delta) {
      await baseMeter.recordUsage(session, employeeId, day, delta);
      metricsState.tokenUsage.calls += 1;
      if (delta.estimated) {
        metricsState.tokenUsage.estIn += delta.inputTokens;
        metricsState.tokenUsage.estOut += delta.outputTokens;
      } else {
        metricsState.tokenUsage.providerIn += delta.inputTokens;
        metricsState.tokenUsage.providerOut += delta.outputTokens;
      }
    },
  };

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
    metricsState.signals += 1;
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
      {
        policy: retryPolicy,
        classify,
        sleep,
        onRetry: () => {
          metricsState.sessionOpenRetries += 1;
          metricsState.retries += 1;
        },
      },
    )
      .then((session) => {
        lane.session = session;
        return session;
      })
      .catch((cause) => {
        metricsState.sessionOpenFailures += 1;
        throw cause;
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

  // ── 窗口有界收敛（D1 返工）──────────────────────────────────────────────

  /** 中止在途窗口：reason 成为 waiter 的归一化结算错误码；重复中止幂等。 */
  function abortWindow(lane: Lane, reason: WindowAbortReason): void {
    const abort = lane.windowAbort;
    if (!abort || abort.signal.aborted) return;
    lane.windowAbortReason = reason;
    abort.abort();
  }

  /** 看门狗：窗口超过硬截止（windowDeadlineMs）按孤儿窗口收敛。返回解除函数。 */
  function armWindowWatchdog(lane: Lane): () => void {
    const timer = setTimeout(() => abortWindow(lane, "window-lease-expired"), windowDeadlineMs);
    return () => clearTimeout(timer);
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
    const row = rows?.[0] ?? null;
    if (row) metricsState.triggers.pendingApprox = Math.max(0, metricsState.triggers.pendingApprox - 1);
    return row;
  }

  /**
   * 中止路径的触发 lease 释放（best-effort）：窗口被 abort 后把行清回
   * "leased/running 但 lease 缺失"态，让 reconcile 不必等 TTL 到期即可
   * 原子回收并按 run snapshot 收敛；失败只意味着退回 TTL 到期回收路径。
   */
  async function clearTriggerLease(session: TriggerSession, triggerId: string): Promise<void> {
    try {
      await session.query(
        `UPDATE $trigger SET lease_expires_at = NONE
         WHERE id = $trigger AND status INSIDE ["leased", "running"];`,
        { trigger: new StringRecordId(triggerId) },
      );
    } catch {
      // 回收兜底仍是 lease 到期，无需上报
    }
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
    if (status === "running") {
      runningTriggers.add(triggerId);
    } else if (runningTriggers.delete(triggerId)) {
      if (status === "completed") metricsState.triggers.completed += 1;
      else if (status === "failed") metricsState.triggers.failed += 1;
      else metricsState.triggers.waiting += 1;
    }
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
      runId: typeof row.run_id === "string" ? row.run_id : null,
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
            retry: {
              policy: retryPolicy,
              classify,
              sleep,
              onRetry: () => {
                metricsState.retries += 1;
              },
            },
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
    abortSignal?: AbortSignal,
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
    // 窗口被 abort（关停到点）→ 尽力把中止传到 workflow 层（run.cancel），
    // 之后 reconcile 看到 canceled snapshot 会把触发收敛为 failed。
    if (abortSignal) {
      const kick = () => {
        void Promise.resolve()
          .then(() => driver.abort?.())
          .catch(() => undefined);
      };
      if (abortSignal.aborted) kick();
      else abortSignal.addEventListener("abort", kick, { once: true });
    }
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
   * 窗口 abort 竞速件：signal 触发即返回带归一化原因的失败结果
   * （lane.windowAbortReason 由 abortWindow 设置）。游离的 driveRun 由
   * 调用方挂 catch 吞 rejection，其后续写库行为如实（abort → run.cancel
   * 后通常立即 failed；若 handler 已收尾则 completed）。
   */
  function abortedOutcome(lane: Lane, signal: AbortSignal): Promise<EnqueueResult> {
    return new Promise((resolve) => {
      const done = () =>
        resolve({ outcome: "failed", error: lane.windowAbortReason ?? "window-aborted" });
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * drain 窗口：全局信号量槽位 → 员工互斥行 → FIFO 认领驱动触发，
   * 直到排空、步数截断（maxTriggersPerWindow）、进程停闸或关停到点 abort。
   */
  async function runWindow(lane: Lane): Promise<void> {
    const release = await acquireWindowSlot();
    const abort = new AbortController();
    lane.windowAbort = abort;
    lane.windowAbortReason = undefined;
    lane.windowStartedAt = now().getTime();
    // 看门狗：窗口整体超过硬截止（首触发前已武装；每条触发结算后重置）
    // 按孤儿窗口收敛——会话死挂（SDK 不报错）也在时限内结束。
    let disarmWatchdog = armWindowWatchdog(lane);
    let crashed = false;
    let aborted = false;
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
        while (started && !abort.signal.aborted && processed < limits.maxTriggersPerWindow) {
          let claimed: TriggerRow | null;
          try {
            claimed = await claimNextPending(session, lane);
          } catch (cause) {
            // 取件本身故障（会话断开/存储异常）= 窗口级崩溃：行保持 pending，
            // waiter 如实失败，交给下投递或 reconcile 重启窗口。
            crashed = true;
            const error = normalizeDeliveryError(errorMessage(cause));
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
            const driving = driveRun(session, claimed, envelope, lane, steps, abort.signal);
            driving.catch(() => undefined);
            const outcome = await Promise.race([driving, abortedOutcome(lane, abort.signal)]);
            if (abort.signal.aborted) {
              // 窗口被中止（stop 到点 / 看门狗 / 会话失效）：abort 已下发给
              // driver（run.cancel），清回触发 lease 供 reconcile 立即回收；
              // 游离 driveRun 的写库结果如实落库。
              aborted = true;
              const reason = lane.windowAbortReason ?? "window-aborted";
              console.warn("[employee-trigger] window aborted", {
                database: lane.database,
                employeeId: lane.employeeId,
                triggerId,
                runId: `er-${triggerId}`,
                reason,
              });
              settleWaiter(lane, triggerId, { outcome: "failed", triggerId, error: reason });
              await clearTriggerLease(session, triggerId);
              break;
            }
            settleWaiter(lane, triggerId, outcome);
            // 本触发已收敛：看门狗重置，给下一条触发完整时限。
            disarmWatchdog();
            disarmWatchdog = armWindowWatchdog(lane);
          } catch (cause) {
            // 基础设施异常（storage 读写失败、驱动崩溃、会话断开）：不打 failed——
            // 该行保留 leased/running 与 lease 到期时间，交给 reconcile/下次投递
            // 按 durable 语义回收。本窗口如实上报这次尝试失败并停止 drain。
            crashed = true;
            const error = normalizeDeliveryError(errorMessage(cause));
            console.error("[employee-trigger] window crashed", {
              database: lane.database,
              employeeId: lane.employeeId,
              reason,
              idempotencyKey,
              triggerId,
              runId: `er-${triggerId}`,
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
        crashed = true;
        const error = normalizeDeliveryError(errorMessage(cause));
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
      disarmWatchdog();
      if (aborted) metricsState.windows.aborted += 1;
      else if (crashed) metricsState.windows.crashed += 1;
      else if (started || abort.signal.aborted) metricsState.windows.completed += 1;
      lane.windowAbort = undefined;
      lane.windowAbortReason = undefined;
      lane.windowStartedAt = undefined;
      release();
      lane.windowPlanned = false;
      await housekeeping(lane);
    }
  }

  return {
    start() {
      metricsState.startedAt ??= now();
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
        // D1 返工：死会话上的查询异常同样收敛到这里——归一化错误码，不透出 SDK 原始串。
        return { outcome: "failed", error: normalizeDeliveryError(errorMessage(cause)) };
      }
      metricsState.triggers.enqueued += 1;
      const triggerId = row?.id == null ? undefined : String(row.id);
      if (!triggerId) return { outcome: "failed", error: "employee-trigger-persist-failed" };
      if (row?.status === "completed") {
        metricsState.triggers.coalesced += 1;
        await housekeeping(lane);
        return { outcome: "coalesced", triggerId };
      }
      if (row?.status === "waiting") {
        metricsState.triggers.coalesced += 1;
        await housekeeping(lane);
        return { outcome: "waiting", triggerId };
      }
      if (row?.status === "failed") {
        // failed 是同键终态：如实回报既有失败，不隐式重跑。
        metricsState.triggers.coalesced += 1;
        await housekeeping(lane);
        const message = typeof row.error_message === "string" ? row.error_message : "trigger-failed";
        return { outcome: "failed", triggerId, error: message };
      }
      // 全新 pending 行（未被认领过）计入 pending 观测近似值。
      if (row?.status === "pending" && !row.lease_expires_at && !row.attempts) {
        metricsState.triggers.pendingApprox += 1;
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
        metricsState.reconcile.runs += 1;
        metricsState.reconcile.lastRunAt = now().toISOString();
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
        metricsState.reconcile.scanned += summary.scanned;
        if (!rows || rows.length === 0) {
          await housekeeping(lane);
          return summary;
        }
        const release = await acquireWindowSlot();
        const abort = new AbortController();
        lane.windowAbort = abort;
        lane.windowAbortReason = undefined;
        lane.windowStartedAt = now().getTime();
        const disarmWatchdog = armWindowWatchdog(lane);
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
              if (!started || abort.signal.aborted) break;
              const triggerId = String(row.id);
              const claimed = await claimLease(session, triggerId);
              if (!claimed) continue;
              summary.reclaimed += 1;
              metricsState.reconcile.reclaimed += 1;
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
                const driving = driveRun(session, claimed, envelope, lane, steps, abort.signal);
                driving.catch(() => undefined);
                const outcome = await Promise.race([driving, abortedOutcome(lane, abort.signal)]);
                if (abort.signal.aborted) {
                  const reason = lane.windowAbortReason ?? "window-aborted";
                  metricsState.windows.aborted += 1;
                  summary.failed += 1;
                  settleWaiter(lane, triggerId, { outcome: "failed", triggerId, error: reason });
                  await clearTriggerLease(session, triggerId);
                  break;
                }
                if (outcome.outcome === "completed") summary.completed += 1;
                else if (outcome.outcome === "waiting") summary.waiting += 1;
                else summary.failed += 1;
                settleWaiter(lane, triggerId, outcome);
              } catch (cause) {
                summary.failed += 1;
                settleWaiter(lane, triggerId, {
                  outcome: "failed",
                  triggerId,
                  error: normalizeDeliveryError(errorMessage(cause)),
                });
                break;
              }
            }
            await sweepWaiters(lane, session);
          } finally {
            await releaseWindow(session, employeeId, holder).catch(() => undefined);
          }
        } finally {
          disarmWatchdog();
          lane.windowAbort = undefined;
          lane.windowAbortReason = undefined;
          lane.windowStartedAt = undefined;
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
        let disarmWatchdog: (() => void) | null = null;
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
          const abort = new AbortController();
          lane.windowAbort = abort;
          lane.windowAbortReason = undefined;
          lane.windowStartedAt = now().getTime();
          disarmWatchdog = armWindowWatchdog(lane);
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
            if (driver.abort) {
              abort.signal.addEventListener(
                "abort",
                () => {
                  void Promise.resolve()
                    .then(() => driver.abort?.())
                    .catch(() => undefined);
                },
                { once: true },
              );
            }
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
            const resuming = driver.resume({ runId, trigger: envelope, resumeData });
            resuming.catch(() => undefined);
            const raced = await Promise.race<EmployeeRunResult | "aborted">([
              resuming.then((r) => r),
              abortedOutcome(lane, abort.signal).then(() => "aborted" as const),
            ]);
            if (raced === "aborted") {
              metricsState.windows.aborted += 1;
              await clearTriggerLease(session, triggerId);
              return {
                outcome: "failed",
                triggerId,
                error: lane.windowAbortReason ?? "window-aborted",
              };
            }
            const result = raced;
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
          const raw = errorMessage(cause);
          console.error("[employee-trigger] resume crashed", { database, employeeId, triggerId, message: raw });
          return { outcome: "failed", triggerId, error: normalizeDeliveryError(raw) };
        } finally {
          disarmWatchdog?.();
          lane.windowAbort = undefined;
          lane.windowAbortReason = undefined;
          lane.windowStartedAt = undefined;
          release?.();
          await housekeeping(lane);
        }
      });
    },

    onSignal(emitter) {
      signalSubscribers.push(emitter);
    },

    stop(options) {
      if (!stopping) {
        stopping = (async () => {
        const t0 = now().getTime();
        started = false;
        // 先停收：新投递拒绝、未决 waiter 如实失败，窗口内级联投递因
        // started=false 不再排新窗口。
        for (const lane of lanes.values()) {
          settleAllWaiters(lane, "failed", "employee-trigger-runtime-stopped");
        }
        const tails = () =>
          Promise.allSettled([...lanes.values()].map((lane) => lane.tail));
        // 等待排空，带截止：返回 true=排空 / false=到点。
        const deadline = (ms: number): Promise<boolean> =>
          Number.isFinite(ms)
            ? Promise.race([tails().then(() => true), sleep(ms).then(() => false)])
            : tails().then(() => true);
        let timedOut = false;
        let abortedWindows = 0;
        const deadlineMs = options?.deadlineMs ?? shutdownDeadlineMs;
        if (!(await deadline(deadlineMs))) {
          timedOut = true;
          // 到点：对在途窗口发 abort（窗口任务竞速收尾 + driver.abort →
          // run.cancel），再宽限 abortGraceMs；仍排不完的不再等。
          for (const lane of lanes.values()) {
            if (lane.windowAbort && !lane.windowAbort.signal.aborted) {
              abortWindow(lane, "window-aborted");
              abortedWindows += 1;
            }
          }
          await deadline(abortGraceMs);
        }
        for (const lane of lanes.values()) {
          await inPersist(lane, () => closeLaneSession(lane)).catch(() => undefined);
        }
        lanes.clear();
        metricsState.shutdowns.push({
          at: now().toISOString(),
          durationMs: now().getTime() - t0,
          timedOut,
          abortedWindows,
        });
        })();
      }
      return stopping;
    },

    invalidateSession(input) {
      // 只取既有 lane，不为未知员工凭空创建；同步清缓存 + 中止在途窗口，
      // 不 await 任何关闭动作（避免与 persist 互斥链互等死锁）。
      const lane = lanes.get(keyOf(input.database, input.employeeId));
      if (!lane) return;
      lane.session = undefined;
      abortWindow(lane, "employee-session-closed");
    },

    metrics() {
      const connectionStats = deps.sessions.sessionStats?.() ?? {
        activeSessions: 0,
        connects: 0,
        reconnects: 0,
        disconnects: 0,
        renewals: 0,
        renewalFailures: 0,
        invalidated: 0,
      };
      const nowMs = now().getTime();
      let oldestWindowAgeMs: number | null = null;
      for (const lane of lanes.values()) {
        if (lane.windowStartedAt == null) continue;
        const age = Math.max(0, nowMs - lane.windowStartedAt);
        oldestWindowAgeMs = oldestWindowAgeMs == null ? age : Math.max(oldestWindowAgeMs, age);
      }
      const last = metricsState.shutdowns.at(-1);
      return {
        started,
        startedAt: metricsState.startedAt?.toISOString() ?? null,
        uptimeMs: metricsState.startedAt ? Math.max(0, nowMs - metricsState.startedAt.getTime()) : 0,
        sessions: {
          open: connectionStats.activeSessions,
          openRetries: metricsState.sessionOpenRetries,
          openFailures: metricsState.sessionOpenFailures,
        },
        windows: {
          running: activeWindows,
          queued: windowQueue.length,
          completed: metricsState.windows.completed,
          crashed: metricsState.windows.crashed,
          aborted: metricsState.windows.aborted,
        },
        triggers: {
          enqueued: metricsState.triggers.enqueued,
          coalesced: metricsState.triggers.coalesced,
          pendingApprox: metricsState.triggers.pendingApprox,
          running: runningTriggers.size,
          completed: metricsState.triggers.completed,
          failed: metricsState.triggers.failed,
          waiting: metricsState.triggers.waiting,
        },
        retries: metricsState.retries,
        tokenUsage: {
          providerInputTokens: metricsState.tokenUsage.providerIn,
          providerOutputTokens: metricsState.tokenUsage.providerOut,
          estimatedInputTokens: metricsState.tokenUsage.estIn,
          estimatedOutputTokens: metricsState.tokenUsage.estOut,
          calls: metricsState.tokenUsage.calls,
        },
        lease: { activeWindows, oldestWindowAgeMs },
        connections: connectionStats,
        reconcile: {
          runs: metricsState.reconcile.runs,
          scanned: metricsState.reconcile.scanned,
          reclaimed: metricsState.reconcile.reclaimed,
          lastRunAt: metricsState.reconcile.lastRunAt,
        },
        shutdown: {
          runs: metricsState.shutdowns.length,
          timedOut: last?.timedOut ?? false,
          abortedWindows: last?.abortedWindows ?? 0,
          durationMs: last?.durationMs ?? null,
        },
        signals: metricsState.signals,
      };
    },
  };
}
