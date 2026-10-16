/**
 * PG-1 停滞防护：run 级操作诊断器 + 有界等待原语。
 *
 * 背景：生产 run 曾在 execute-one 内部停住（最后一个 provider 调用之后无工具、
 * 无 step 持久化、无错误），直到 600s 总预算兜底取消，期间没有任何在途操作记录。
 * 本模块给「run 内发生了什么」建立最小账本：
 * - 每个 connect / query / persist / tool / executor 操作开始时记账（name 为脱敏
 *   稳定名：工具 id、SQL 语句首关键字、阶段名），结束时记终态 + 时长 + 稳定错误名；
 * - 取消（上游 AbortSignal）时在途操作标记为 cancelled，快照可立刻读/持久化，
 *   不等待被挂起的执行体返回；
 * - 永不记录 SQL 文本、变量值、行数据、token、subject 或无界输出。
 */

/** 操作阶段：DB 侧 connect/query/result-processing/persist + 调度侧 tool/executor。 */
export type RunOpPhase =
  | "connect"
  | "query"
  | "result-processing"
  | "persist"
  | "tool"
  | "executor";

export type RunOpOutcome = "ok" | "failed" | "timeout" | "cancelled";
export type RunOpStatus = "in-flight" | RunOpOutcome;

/** 单条操作记录（全部字段可安全持久化；error 只存稳定 code/name，不存 message）。 */
export type RunOpRecord = {
  seq: number;
  name: string;
  phase: RunOpPhase;
  status: RunOpStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** 参数形状（顶层 key 名 / 绑定名），永不含值。 */
  argShape?: string[];
  /** 稳定错误名（ai-tool-timeout / ai-caller-query-timeout / Error.name 等）。 */
  error?: string;
};

export type RunDiagnosticsSnapshot = {
  version: 1;
  /** runId 在 bindRun 后可填；路由期（claim/授权）查询无 runId。 */
  runId?: string;
  recordedAt: string;
  reason: string;
  aborted: boolean;
  /** 快照时刻仍在飞的操作（取消事件的主力证据）。 */
  inFlight: RunOpRecord[];
  /** 最近完成的操作尾部（有界，最早的丢弃）。 */
  completed: RunOpRecord[];
  totals: { started: number; finished: number };
  /** 触发 run 级终止的具名错误（超时类），缺席 = 无 fatal。 */
  fatalError?: string;
  limits: {
    connectTimeoutMs: number;
    queryTimeoutMs: number;
    toolTimeoutMs: number;
    auditWriteTimeoutMs: number;
    deadlineAt?: string;
  };
};

export type RunDiagnosticsConfig = {
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** 终态诊断快照写入自身的时间上界（不得拖住终态）。 */
  auditWriteTimeoutMs?: number;
  /** snapshot 保留的已完成操作尾部上限。 */
  maxCompletedOps?: number;
  /** argShape 记录上限。 */
  maxArgShapeEntries?: number;
  /** 时钟注入点（测试用）。 */
  now?: () => number;
};

export type RunDiagnosticsResolvedConfig = Required<Omit<RunDiagnosticsConfig, "now">>;

export const RUN_DIAGNOSTICS_DEFAULTS: RunDiagnosticsResolvedConfig = {
  connectTimeoutMs: 30_000,
  queryTimeoutMs: 30_000,
  toolTimeoutMs: 60_000,
  auditWriteTimeoutMs: 5_000,
  maxCompletedOps: 50,
  maxArgShapeEntries: 24,
};

/** 配置只接受正数有界值：0 / 负数 / NaN / Infinity 一律拒绝。 */
export function resolveRunDiagnosticsConfig(config: RunDiagnosticsConfig = {}): RunDiagnosticsResolvedConfig {
  const resolved = { ...RUN_DIAGNOSTICS_DEFAULTS };
  for (const key of Object.keys(RUN_DIAGNOSTICS_DEFAULTS) as (keyof RunDiagnosticsResolvedConfig)[]) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`run-diagnostics: ${key} 必须是正数有界值，收到 ${String(value)}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

// ─── 稳定命名错误 ─────────────────────────────────────────────────────────────

export const AI_TOOL_TIMEOUT_CODE = "ai-tool-timeout";
export const AI_CALLER_QUERY_TIMEOUT_CODE = "ai-caller-query-timeout";
export const AI_RUN_CANCELLED_CODE = "ai-run-cancelled";

/** 工具执行超过有界上界（默认 60s，有效值 = min(配置, run 剩余期限)）。 */
export class AiToolTimeoutError extends Error {
  readonly code = AI_TOOL_TIMEOUT_CODE;
  constructor(toolName?: string) {
    super(toolName ? `AI 工具执行超时（${toolName}）：限定时间内未完成，请重试。` : "AI 工具执行超时：限定时间内未完成，请重试。");
    this.name = "AiToolTimeoutError";
  }
}

/** 调用者会话单次 connect/query 超过有界上界（默认 30s）。 */
export class AiCallerQueryTimeoutError extends Error {
  readonly code = AI_CALLER_QUERY_TIMEOUT_CODE;
  constructor(operation = "query") {
    super(`AI 数据库操作超时（${operation}）：限定时间内未完成，请重试。`);
    this.name = "AiCallerQueryTimeoutError";
  }
}

/** 上游 AbortSignal（run 取消 / deadline）打断在途操作。 */
export class AiRunCancelledError extends Error {
  readonly code = AI_RUN_CANCELLED_CODE;
  constructor(message = "本次 AI 运行已被取消。") {
    super(message);
    this.name = "AiRunCancelledError";
  }
}

/** 稳定错误名：优先显式 code，其次 Error.name；绝不返回 message 文本。 */
export function stableErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "Error";
}

/**
 * 迟到结果屏蔽：Promise.race 判负后给底层 promise 挂空处理，
 * 防止迟到 settle 变成 unhandled rejection（Surreal SDK 无 query 级取消，
 * 在途请求只能等连接关闭时由 SDK reject）。
 */
export function maskLateSettlement(inner: PromiseLike<unknown>): void {
  void Promise.resolve(inner).then(
    () => undefined,
    () => undefined,
  );
}

const TIMEOUT_SENTINEL = Symbol("run-diagnostics.timeout");
const ABORT_SENTINEL = Symbol("run-diagnostics.abort");

/** 把多个 AbortSignal 合成一个语义信号（任一触发即算）；返回 undefined 表示无信号。 */
export function firstAbortOf(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.length === 0) return undefined;
  if (live.some((signal) => signal.aborted)) return ABORTED_NOW;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of live) signal.addEventListener("abort", onAbort, { once: true });
  // 合成信号触发后解挂上游监听，避免 run 结束后泄漏在 signal 上。
  controller.signal.addEventListener("abort", () => {
    for (const signal of live) signal.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}

const ABORTED_NOW = (() => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
})();

export type BoundedAwaitOptions = {
  /** 有效上界（调用方已折算剩余期限）。 */
  timeoutMs: number;
  /** 附加取消信号（诊断器自身信号由 track() 自动并入）。 */
  signal?: AbortSignal;
  timeoutError: () => Error;
  abortedError?: () => Error;
  /** 超时触发回调（置 fatal / 关连接等副作用挂这里）。 */
  onTimeout?: () => void;
  /** 取消触发回调。 */
  onAbort?: () => void;
};

/**
 * 有界等待：超时/取消时屏蔽迟到 settle 并抛具名错误。
 * 不伪造成功、不吞错误——被中断的 awaiter 一定拿到异常。
 */
export function boundedAwait<T>(inner: PromiseLike<T>, options: BoundedAwaitOptions): Promise<T> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  const innerPromise = Promise.resolve(inner);
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(ABORT_SENTINEL);
    const finish = (verdict: T | typeof TIMEOUT_SENTINEL | typeof ABORT_SENTINEL | { error: unknown }) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (verdict === TIMEOUT_SENTINEL) {
        maskLateSettlement(innerPromise);
        options.onTimeout?.();
        reject(options.timeoutError());
        return;
      }
      if (verdict === ABORT_SENTINEL) {
        maskLateSettlement(innerPromise);
        options.onAbort?.();
        reject(options.abortedError?.() ?? new AiRunCancelledError());
        return;
      }
      if (typeof verdict === "object" && verdict !== null && "error" in verdict) {
        reject((verdict as { error: unknown }).error);
        return;
      }
      resolve(verdict as T);
    };
    timer = setTimeout(() => finish(TIMEOUT_SENTINEL), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    if (signal) {
      if (signal.aborted) {
        finish(ABORT_SENTINEL);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    innerPromise.then(
      (value) => finish(value),
      (error) => finish({ error }),
    );
  });
}

// ─── 诊断器 ──────────────────────────────────────────────────────────────────

export type RunOpHandle = { readonly seq: number };

type MutableOp = {
  handle: RunOpHandle;
  record: RunOpRecord;
  startedAtMs: number;
};

export type RunDiagnostics = {
  readonly config: RunDiagnosticsResolvedConfig;
  /** run 级信号（chat-service 的 AbortController.signal）。 */
  readonly runSignal: AbortSignal | undefined;
  /** 绑定 run 作用域：上游信号、绝对期限、取消回调。重复绑定只认首个 signal/deadline。 */
  bindRun(input: { runId?: string; signal?: AbortSignal; deadlineAt?: number; cancelRun?: () => void }): void;
  begin(input: { name: string; phase: RunOpPhase; argShape?: string[] }): RunOpHandle;
  /** 操作内阶段迁移（如 query 收到响应后进入 result-processing）。 */
  markPhase(handle: RunOpHandle, phase: RunOpPhase): void;
  end(handle: RunOpHandle, outcome: RunOpOutcome, error?: unknown): void;
  /** 标记 run 级致命错误（超时类），并触发 cancelRun；幂等。 */
  fail(error: unknown): void;
  readonly fatalError: Error | undefined;
  readonly aborted: boolean;
  /** 距 run 期限的剩余毫秒；未绑定期限时 undefined。 */
  remainingMs(): number | undefined;
  /** 有效操作上界 = min(配置, 剩余期限)；无期限时 = 配置。 */
  effectiveMs(configuredMs: number): number;
  /**
   * 记账 + 有界等待：begin → boundedAwait → end。
   * 超时记 timeout + fail()（触发 run 取消）；上游 abort 记 cancelled。
   */
  track<T>(
    op: { name: string; phase: RunOpPhase; argShape?: string[] },
    work: PromiseLike<T>,
    bound: { timeoutMs: number; signal?: AbortSignal; timeoutError: () => Error; abortedError?: () => Error; onTimeout?: () => void },
  ): Promise<T>;
  /** 与 track 相同，但复用调用方已 begin 的 op（懒派发包装场景：begin 在调用点，bound 在终结点）。 */
  trackOp<T>(
    handle: RunOpHandle,
    work: PromiseLike<T>,
    bound: {
      timeoutMs: number;
      signal?: AbortSignal;
      /** persist 等终态清理操作：不随 run 信号取消（它们恰恰是取消后要完成的清理）。 */
      skipRunSignal?: boolean;
      timeoutError: () => Error;
      abortedError?: () => Error;
      onTimeout?: () => void;
    },
  ): Promise<T>;
  /** 同步阶段段记账（如查询后的结果整形）：begin → 执行 → end，记录时长与抛错。 */
  span<T>(op: { name: string; phase: RunOpPhase; argShape?: string[] }, fn: () => T): T;
  /** 取消/终态时刻的脱敏快照：在途 + 已完成尾部 + 累计数。 */
  snapshot(reason: string): RunDiagnosticsSnapshot;
};

export function createRunDiagnostics(config: RunDiagnosticsConfig = {}): RunDiagnostics {
  const resolved = resolveRunDiagnosticsConfig(config);
  const now = config.now ?? Date.now;
  const ops = new Map<number, MutableOp>();
  let seq = 0;
  let started = 0;
  let finished = 0;
  let runId: string | undefined;
  let cancelRun: (() => void) | undefined;
  let deadlineAt: number | undefined;
  let fatal: Error | undefined;
  let isAborted = false;
  let runSignal: AbortSignal | undefined;

  const toRecord = (op: MutableOp): RunOpRecord => ({ ...op.record, argShape: op.record.argShape ? [...op.record.argShape] : undefined });

  const markAborted = () => {
    if (isAborted) return;
    isAborted = true;
    // 取消发生即在途操作记 cancelled——不等底层 promise 返回（它可能永远不返回）。
    for (const op of ops.values()) {
      if (op.record.status === "in-flight") {
        endOp(op, "cancelled", new AiRunCancelledError());
      }
    }
  };

  const endOp = (op: MutableOp, outcome: RunOpOutcome, error?: unknown) => {
    // 取消瞬间在途 op 先落 cancelled；真正的超时错误传播上来时改写为
    // timeout ——超时是取消的根因，保留它比 cancelled 更有诊断价值。
    if (op.record.status !== "in-flight") {
      if (!(op.record.status === "cancelled" && outcome === "timeout")) return;
    }
    const endedAtMs = now();
    op.record.status = outcome;
    op.record.endedAt = new Date(endedAtMs).toISOString();
    op.record.durationMs = Math.max(0, Math.round(endedAtMs - op.startedAtMs));
    if (error !== undefined) op.record.error = stableErrorCode(error);
    finished += 1;
  };

  const diag: RunDiagnostics = {
    config: resolved,
    get runSignal() {
      return runSignal;
    },
    get fatalError() {
      return fatal;
    },
    get aborted() {
      return isAborted;
    },
    bindRun(input) {
      if (input.runId !== undefined) runId ??= input.runId;
      if (input.cancelRun !== undefined) cancelRun ??= input.cancelRun;
      if (input.deadlineAt !== undefined) deadlineAt ??= input.deadlineAt;
      if (input.signal !== undefined && runSignal === undefined) {
        runSignal = input.signal;
        if (runSignal.aborted) {
          markAborted();
        } else {
          runSignal.addEventListener("abort", markAborted, { once: true });
        }
      }
    },
    begin(input) {
      seq += 1;
      started += 1;
      const argShape = input.argShape === undefined
        ? undefined
        : input.argShape.slice(0, resolved.maxArgShapeEntries);
      const op: MutableOp = {
        handle: { seq },
        startedAtMs: now(),
        record: {
          seq,
          name: input.name,
          phase: input.phase,
          status: "in-flight",
          startedAt: new Date(now()).toISOString(),
          ...(argShape !== undefined && argShape.length > 0 ? { argShape } : {}),
        },
      };
      ops.set(seq, op);
      return op.handle;
    },
    markPhase(handle, phase) {
      const op = ops.get(handle.seq);
      if (!op || op.record.status !== "in-flight") return;
      op.record.phase = phase;
    },
    end(handle, outcome, error) {
      const op = ops.get(handle.seq);
      if (!op) return;
      endOp(op, outcome, error);
    },
    fail(error) {
      if (fatal === undefined) {
        fatal = error instanceof Error ? error : new Error(stableErrorCode(error));
      }
      cancelRun?.();
    },
    remainingMs() {
      return deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - now());
    },
    effectiveMs(configuredMs) {
      const remaining = diag.remainingMs();
      if (remaining === undefined) return configuredMs;
      return Math.max(1, Math.min(configuredMs, remaining));
    },
    track(opInput, work, bound) {
      return diag.trackOp(diag.begin(opInput), work, bound);
    },
    async trackOp(handle, work, bound) {
      const op = ops.get(handle.seq);
      try {
        const result = await boundedAwait(work, {
          timeoutMs: bound.timeoutMs,
          signal: bound.skipRunSignal ? bound.signal : firstAbortOf([runSignal, bound.signal]),
          timeoutError: bound.timeoutError,
          abortedError: bound.abortedError,
          onTimeout: bound.onTimeout,
        });
        if (op) endOp(op, "ok");
        return result;
      } catch (error) {
        // 具名超时错误 → timeout；取消错误 → cancelled；其余 → failed。
        const outcome: RunOpOutcome = isTimeoutError(error) ? "timeout"
          : error instanceof AiRunCancelledError ? "cancelled"
          : "failed";
        if (op) endOp(op, outcome, error);
        if (outcome === "timeout") diag.fail(error);
        throw error;
      }
    },
    span(opInput, fn) {
      const op = ops.get(diag.begin(opInput).seq)!;
      try {
        const result = fn();
        endOp(op, "ok");
        return result;
      } catch (error) {
        endOp(op, "failed", error);
        throw error;
      }
    },
    snapshot(reason) {
      const records = [...ops.values()].map(toRecord);
      const inFlight = records.filter((record) => record.status === "in-flight");
      const completed = records.filter((record) => record.status !== "in-flight").slice(-resolved.maxCompletedOps);
      return {
        version: 1,
        ...(runId !== undefined ? { runId } : {}),
        recordedAt: new Date(now()).toISOString(),
        reason,
        aborted: isAborted,
        inFlight,
        completed,
        totals: { started, finished },
        ...(fatal !== undefined ? { fatalError: stableErrorCode(fatal) } : {}),
        limits: {
          connectTimeoutMs: resolved.connectTimeoutMs,
          queryTimeoutMs: resolved.queryTimeoutMs,
          toolTimeoutMs: resolved.toolTimeoutMs,
          auditWriteTimeoutMs: resolved.auditWriteTimeoutMs,
          ...(deadlineAt !== undefined ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}),
        },
      };
    },
  };
  return diag;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof AiToolTimeoutError || error instanceof AiCallerQueryTimeoutError;
}

/** 把任意抛错映射成 op 终态：具名超时 → timeout，abort 类 → cancelled，其余 → failed。 */
export function outcomeForError(error: unknown): RunOpOutcome {
  if (isTimeoutError(error)) return "timeout";
  if (error instanceof AiRunCancelledError) return "cancelled";
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return "failed";
}
