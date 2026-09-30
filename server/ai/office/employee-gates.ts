import { StringRecordId } from "surrealdb";
import type { TriggerSession } from "./employee-trigger-runtime";

/**
 * 预算、循环、重试与全局背压闸门（VER05）。
 *
 * 本模块是 employee-trigger-runtime 的闸门零件包：
 * - RuntimeSignal：达到限制时输出的结构化信号；runtime 统一经 emitSignal
 *   回调吐给业务 adapter（通知方式由 adapter 决定），并按需落审计字段。
 * - 错误分类 + 有界退避：权限/校验类判 permanent 不重试；网络、provider、
 *   rate-limit 类判 transient 按上限指数退避（带抖动）。
 * - EmployeeUsageMeter：每日 token 用量 seam。生产实现走员工 RECORD 会话
 *   写 employee_token_usage（037 增量：(employee, day) 唯一 upsert 原子
 *   累计，provider/estimate 计量来源分列）；测试可注入内存替身。
 * - MeteredModel：每次模型调用的硬闸门——步数计数、preflight 剩余额度
 *   决定本次最大输出、invoke 有界重试、调用后按 provider usage 或有界
 *   估算记账、同日同员工 budget-exhausted signal 只发一次（usage 行
 *   budget_signal_at CAS 抢占）。
 */

// ── 结构化 runtime signal ────────────────────────────────────────────────

export type RuntimeSignalKind =
  /** 员工当日 token 预算耗尽：后续模型调用不再发起（同日同员工只发一次）。 */
  | "budget-exhausted"
  /** 级联触发链深度超上限：该次投递被拒绝。 */
  | "chain-depth-exceeded"
  /** 触发认领次数超上限：同键转 failed 终态。 */
  | "retry-exhausted"
  /** 单执行窗口内模型调用步数超上限：该次调用被拒绝。 */
  | "step-limit-exceeded";

export type RuntimeSignal = {
  kind: RuntimeSignalKind;
  at: Date;
  database: string;
  employeeId: string;
  triggerId?: string;
  reason?: string;
  detail: Record<string, unknown>;
};

export type RuntimeSignalEmitter = (signal: RuntimeSignal) => void | Promise<void>;

// ── 闸门错误：handler/adapter 按 kind 区分硬闸门终止与一般失败 ─────────────

export type GateErrorKind = "budget-exhausted" | "step-limit-exceeded";

export class EmployeeGateError extends Error {
  readonly kind: GateErrorKind;
  constructor(kind: GateErrorKind, detail?: string) {
    super(detail ? `${kind}:${detail}` : kind);
    this.name = "EmployeeGateError";
    this.kind = kind;
  }
}

// ── 错误分类与有界退避 ────────────────────────────────────────────────────

export type ErrorClass = "transient" | "permanent";
export type ErrorClassifier = (cause: unknown) => ErrorClass;

const PERMANENT_PATTERNS: RegExp[] = [
  /permission|forbidden|unauthori[sz]ed|unauthenticated|access denied/i,
  /validation|invalid|schemafull|assert/i,
  /employee-credential-missing|employee-session-unavailable|employee-runtime-stopped/i,
  /no such employee|credential/i,
  /no-handler:|trigger-not-waiting|snapshot-missing|employee-trigger-runtime-stopped/i,
  /budget-exhausted|step-limit-exceeded|chain-depth-exceeded/i,
];
const TRANSIENT_PATTERNS: RegExp[] = [
  /rate.?limit|too many|throttl/i,
  /timeout|timed.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN/i,
  /socket|fetch failed|network|connection|temporar|overloaded|unavailable/i,
];
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 422]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusCodeOf(cause: unknown): number | null {
  if (!cause || typeof cause !== "object") return null;
  const record = cause as Record<string, unknown>;
  const code = record.statusCode ?? record.status;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

/**
 * 默认分类：显式 permanent 形态优先，其次显式 transient 形态；
 * 权限/校验/凭证缺失/闸门终止判 permanent；网络、provider、rate-limit
 * 判 transient；未识别的一律 transient——退避有上限，不会形成重试风暴。
 */
export const defaultErrorClassifier: ErrorClassifier = (cause) => {
  if (cause instanceof EmployeeGateError) return "permanent";
  const status = statusCodeOf(cause);
  if (status !== null) {
    if (PERMANENT_STATUS.has(status)) return "permanent";
    if (TRANSIENT_STATUS.has(status)) return "transient";
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return "permanent";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "transient";
};

export type RetryPolicy = {
  /** 总尝试次数上限（含首次）。 */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 抖动幅度：实际延迟 = delay * (1 ± jitterRatio)。 */
  jitterRatio: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  jitterRatio: 0.25,
};

export type RetryContext = {
  policy?: Partial<RetryPolicy>;
  classify?: ErrorClassifier;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; cause: unknown }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 有界指数退避：permanent 立即抛；transient 最多尝试 maxAttempts 次。 */
export async function withBoundedRetry<T>(fn: () => Promise<T>, ctx: RetryContext = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...ctx.policy };
  const classify = ctx.classify ?? defaultErrorClassifier;
  const sleep = ctx.sleep ?? defaultSleep;
  let attempt = 0;
  let delay = policy.baseDelayMs;
  for (;;) {
    try {
      return await fn();
    } catch (cause) {
      attempt += 1;
      if (attempt >= policy.maxAttempts || classify(cause) === "permanent") throw cause;
      const jitter = delay * (1 + (Math.random() * 2 - 1) * policy.jitterRatio);
      ctx.onRetry?.({ attempt, delayMs: jitter, cause });
      await sleep(jitter);
      delay = Math.min(delay * 2, policy.maxDelayMs);
    }
  }
}

// ── 业务日键（token 预算按此日期分桶）─────────────────────────────────────

/** 用明确时区把时间点映射成 YYYY-MM-DD 日期键；时区由 runtime 配置注入。 */
export function businessDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// ── 闸门限额 ──────────────────────────────────────────────────────────────

export type GateLimits = {
  /** 进程级并发执行窗口上限。 */
  maxConcurrentWindows: number;
  /** 单执行窗口最多 drain 的触发数（背压合并：超出交后续窗口）。 */
  maxTriggersPerWindow: number;
  /** 单执行窗口内模型调用步数上限（handler 循环的兜底闸门）。 */
  maxStepsPerWindow: number;
  /** 触发链深度上限；级联触发由 runtime 继承 parent+1，不可传入更小值绕过。 */
  maxChainDepth: number;
  /** 单触发认领次数上限（含崩溃回收），超出转 failed + retry-exhausted signal。 */
  maxTriggerAttempts: number;
  /** 每员工每业务日 token 预算（provider+estimate 合计）。 */
  dailyTokenBudget: number;
  /** 单次模型调用输出上限的绝对天花板。 */
  maxOutputTokensPerCall: number;
  /** 预算日的业务时区（IANA 名）。 */
  budgetTimezone: string;
  /** provider 未返回 usage 且调用方未申报时的有界输入估算。 */
  fallbackInputTokens: number;
};

export const DEFAULT_GATE_LIMITS: GateLimits = {
  maxConcurrentWindows: 8,
  maxTriggersPerWindow: 32,
  maxStepsPerWindow: 16,
  maxChainDepth: 8,
  maxTriggerAttempts: 5,
  dailyTokenBudget: 250_000,
  maxOutputTokensPerCall: 8_192,
  budgetTimezone: "Asia/Shanghai",
  fallbackInputTokens: 512,
};

// ── 每日 token 用量 seam ───────────────────────────────────────────────────

export type UsageDelta = {
  inputTokens: number;
  outputTokens: number;
  /** true=provider 未返回 usage 时的有界估算；false=provider 实测。 */
  estimated: boolean;
};

export type EmployeeUsageMeter = {
  /** 该员工当日已用 token 总量（provider + estimate 合计）；无行返回 0。 */
  usedTokens(session: TriggerSession, employeeId: string, day: string): Promise<number>;
  /** 原子累计一次调用的用量到 (employee, day) 唯一行。 */
  recordUsage(session: TriggerSession, employeeId: string, day: string, delta: UsageDelta): Promise<void>;
  /**
   * 原子抢占"当日 budget-exhausted signal"发送权（budget_signal_at CAS）：
   * 返回 true = 本次调用赢得发送权，应 emit signal；false = 已发过。
   */
  claimBudgetSignal(session: TriggerSession, employeeId: string, day: string): Promise<boolean>;
};

type UsageRow = {
  provider_input_tokens?: unknown;
  provider_output_tokens?: unknown;
  estimated_input_tokens?: unknown;
  estimated_output_tokens?: unknown;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * 生产计量：员工 RECORD 会话写 employee_token_usage。
 * UPSERT ... WHERE 语义（036 已实测）：行缺失 → 插入；行存在且 WHERE 匹配
 * → 更新（SET 内字段引用为当前值）；行存在但 WHERE 落空 → 返回空。
 */
export function createSurrealUsageMeter(): EmployeeUsageMeter {
  return {
    async usedTokens(session, employeeId, day) {
      const [rows] = await session.query<[UsageRow[]]>(
        `SELECT provider_input_tokens, provider_output_tokens,
                estimated_input_tokens, estimated_output_tokens
         FROM employee_token_usage
         WHERE employee = $employee AND day = $day LIMIT 1;`,
        { employee: new StringRecordId(employeeId), day },
      );
      const row = rows?.[0];
      if (!row) return 0;
      return (
        num(row.provider_input_tokens) +
        num(row.provider_output_tokens) +
        num(row.estimated_input_tokens) +
        num(row.estimated_output_tokens)
      );
    },

    async recordUsage(session, employeeId, day, delta) {
      const providerIn = delta.estimated ? 0 : delta.inputTokens;
      const providerOut = delta.estimated ? 0 : delta.outputTokens;
      const estimatedIn = delta.estimated ? delta.inputTokens : 0;
      const estimatedOut = delta.estimated ? delta.outputTokens : 0;
      await session.query(
        `UPSERT employee_token_usage SET
           employee = $employee,
           day = $day,
           provider_input_tokens = (provider_input_tokens ?? 0) + $providerIn,
           provider_output_tokens = (provider_output_tokens ?? 0) + $providerOut,
           estimated_input_tokens = (estimated_input_tokens ?? 0) + $estimatedIn,
           estimated_output_tokens = (estimated_output_tokens ?? 0) + $estimatedOut,
           calls = (calls ?? 0) + 1,
           updated_at = time::now()
         WHERE employee = $employee AND day = $day;`,
        {
          employee: new StringRecordId(employeeId),
          day,
          providerIn,
          providerOut,
          estimatedIn,
          estimatedOut,
        },
      );
    },

    async claimBudgetSignal(session, employeeId, day) {
      const [rows] = await session.query<[unknown[]]>(
        `UPSERT employee_token_usage SET
           employee = $employee,
           day = $day,
           budget_signal_at = time::now()
         WHERE employee = $employee AND day = $day AND budget_signal_at IS NONE
         RETURN AFTER;`,
        { employee: new StringRecordId(employeeId), day },
      );
      return (rows?.length ?? 0) > 0;
    },
  };
}

// ── 计量模型闸门 ───────────────────────────────────────────────────────────

export type ModelCallGrant = {
  /** 本次允许的最大输出 token 数（preflight 剩余额度封顶后的值）。 */
  maxOutputTokens: number;
};

export type ModelCallUsage = { inputTokens: number; outputTokens: number };

export type ModelCallOutcome<T> = {
  result: T;
  /** provider 实测 usage；缺失/null → 按有界估算记账并标记计量来源。 */
  usage?: ModelCallUsage | null;
};

export type MeteredModel = {
  /**
   * 模型调用硬闸门：
   * 1. 窗口步数 +1，超 maxStepsPerWindow 抛 step-limit-exceeded（不发调用）；
   * 2. 读当日已用 → grant = min(请求上限, 单次天花板, 剩余额度 - 输入估算)；
   *    grant ≤ 0 → CAS 抢当日 budget-exhausted signal 并抛 budget-exhausted；
   * 3. invoke(grant) 按有界退避重试 transient 故障（permanent 不重试）；
   * 4. 按 provider usage 或有界估算（grant 上限）原子累计当日用量。
   */
  call<T>(
    request: { maxOutputTokens: number; estimatedInputTokens?: number },
    invoke: (grant: ModelCallGrant) => Promise<ModelCallOutcome<T>>,
  ): Promise<T>;
};

export function createMeteredModel(scope: {
  session: TriggerSession;
  database: string;
  employeeId: string;
  triggerId?: string;
  reason?: string;
  limits: GateLimits;
  meter: EmployeeUsageMeter;
  emitSignal: (signal: Omit<RuntimeSignal, "at" | "database" | "employeeId">) => Promise<void>;
  now: () => Date;
  /** 窗口级共享步数计数器：同窗口内多个触发/handler 调用共用。 */
  steps: { count: number };
  retry?: RetryContext;
}): MeteredModel {
  const { session, employeeId, limits, meter } = scope;
  return {
    async call(request, invoke) {
      if (scope.steps.count >= limits.maxStepsPerWindow) {
        await scope.emitSignal({
          kind: "step-limit-exceeded",
          triggerId: scope.triggerId,
          reason: scope.reason,
          detail: { steps: scope.steps.count, max: limits.maxStepsPerWindow },
        });
        throw new EmployeeGateError(
          "step-limit-exceeded",
          `${scope.steps.count}>=${limits.maxStepsPerWindow}`,
        );
      }
      scope.steps.count += 1;

      const day = businessDayKey(scope.now(), limits.budgetTimezone);
      const used = await meter.usedTokens(session, employeeId, day);
      const estimatedInput = Math.max(
        0,
        Math.floor(request.estimatedInputTokens ?? limits.fallbackInputTokens),
      );
      const remaining = limits.dailyTokenBudget - used;
      const maxOutputTokens = Math.min(
        Math.floor(request.maxOutputTokens),
        limits.maxOutputTokensPerCall,
        remaining - estimatedInput,
      );
      if (maxOutputTokens <= 0) {
        if (await meter.claimBudgetSignal(session, employeeId, day)) {
          await scope.emitSignal({
            kind: "budget-exhausted",
            triggerId: scope.triggerId,
            reason: scope.reason,
            detail: { day, used, budget: limits.dailyTokenBudget, remaining },
          });
        }
        throw new EmployeeGateError("budget-exhausted", `day=${day} used=${used}`);
      }

      const outcome = await withBoundedRetry(() => invoke({ maxOutputTokens }), scope.retry);
      const usage = outcome.usage;
      const measured =
        usage &&
        Number.isFinite(usage.inputTokens) &&
        Number.isFinite(usage.outputTokens) &&
        usage.inputTokens >= 0 &&
        usage.outputTokens >= 0;
      if (measured) {
        await meter.recordUsage(session, employeeId, day, {
          inputTokens: Math.floor(usage.inputTokens),
          outputTokens: Math.floor(usage.outputTokens),
          estimated: false,
        });
      } else {
        // 无 provider usage：按申报/兜底输入 + 本次输出上限做有界估算，
        // 记 estimated_* 列——标记计量来源，绝不静默记零。
        await meter.recordUsage(session, employeeId, day, {
          inputTokens: estimatedInput,
          outputTokens: maxOutputTokens,
          estimated: true,
        });
      }
      return outcome.result;
    },
  };
}
