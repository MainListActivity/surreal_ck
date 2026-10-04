// 债权对账 · 利息重算引擎（interest-rules/v1）。
// 契约来源 docs/claims-reconciliation/interest-rules.md：
// - 只支持单利 simple；分段单利，各段先四舍五入到分再求和；
// - 半开区间 [起, 止) 日历日计数，闰日计入，年日因子分母固定 365；
// - 无约定违约金为 0；违约金只支持固定金额或按日利率单利，二选一，无复利；
// - 每次结果携带 rule_version，历史快照不被重写。
// 纯函数、无 IO；金额一律 JS number（schema 侧 TYPE number），确定性双精度运算。

export const INTEREST_RULES_VERSION_V1 = "interest-rules/v1";
export const INTEREST_DAYS_PER_YEAR = 365;

/** 申报里可表达的两类违约金约定；未约定传 null / 0。 */
export type ClaimsPenaltySpec =
  | { kind: "fixed_amount"; amount: number }
  | { kind: "daily_rate"; daily_rate: number };

export type ClaimsInterestInput = {
  principal?: unknown;
  rate_segments?: unknown;
  interest_start?: unknown;
  interest_end?: unknown;
  interest_method?: unknown;
  /** number → 固定金额；{kind:…} → 日利率约定；null/undefined → 无约定。 */
  penalty?: unknown;
};

export type CalculatedInterestSegment = {
  index: number;
  /** 各段均为 YYYY-MM-DD，区间 [start, end)。 */
  start: string;
  end: string;
  days: number;
  base: number;
  annual_rate: number;
  interest: number;
};

export type ClaimsInterestSuccess = {
  ok: true;
  rule_version: typeof INTEREST_RULES_VERSION_V1;
  interest_method: "simple";
  principal: number;
  interest_start: string;
  interest_end: string;
  days_total: number;
  segments: CalculatedInterestSegment[];
  total_interest: number;
  penalty: ClaimsPenaltySpec | null;
  penalty_amount: number;
  /** total_interest + penalty_amount，各自先到分再相加。 */
  total_amount: number;
};

export type ClaimsInterestErrorCode =
  | "missing-interest-start"
  | "missing-interest-end"
  | "invalid-interest-start"
  | "invalid-interest-end"
  | "interest-end-not-after-start"
  | "invalid-principal"
  | "empty-rate-segments"
  | "invalid-rate-segment"
  | "rate-segments-not-contiguous"
  | "rate-segments-window-mismatch"
  | "unsupported-interest-method"
  | "invalid-penalty";

export type ClaimsInterestFailure = {
  ok: false;
  error: {
    code: ClaimsInterestErrorCode;
    message: string;
    /** 出错的分段下标等定位信息。 */
    segment_index?: number;
  };
};

export type ClaimsInterestResult = ClaimsInterestSuccess | ClaimsInterestFailure;

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析 YYYY-MM-DD 或 ISO datetime，统一取 UTC 日历日；非法返回 null。 */
function parseDay(value: unknown): { iso: string; epochDay: number } | null {
  if (typeof value !== "string") return null;
  const dateOnly = DAY_RE.exec(value);
  let ms: number;
  if (dateOnly) {
    ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  } else {
    ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
  }
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (dateOnly && (y !== Number(dateOnly[1]) || m !== Number(dateOnly[2]) || d !== Number(dateOnly[3]))) {
    return null; // 2024-02-30 这类不存在的日历日
  }
  const iso = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  return { iso, epochDay: Math.floor(Date.UTC(y, m - 1, d) / DAY_MS) };
}

/**
 * 四舍五入到分（两位小数）。金额均非负；
 * +1e-9 抵消二进制浮点在精确半分边界（如 2.675 存为 2.67499…）的负向误差。
 */
export function roundCents(value: number): number {
  return Math.round(value * 100 + 1e-9) / 100;
}

function fail(
  code: ClaimsInterestErrorCode,
  message: string,
  segment_index?: number,
): ClaimsInterestFailure {
  return { ok: false, error: { code, message, ...(segment_index !== undefined ? { segment_index } : {}) } };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePenalty(value: unknown): { spec: ClaimsPenaltySpec | null } | ClaimsInterestFailure {
  if (value === undefined || value === null) return { spec: null };
  if (isFiniteNumber(value)) {
    if (value < 0) return fail("invalid-penalty", "penalty must be a non-negative number");
    return { spec: value === 0 ? null : { kind: "fixed_amount", amount: value } };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const spec = value as Record<string, unknown>;
    if (spec.kind === "fixed_amount") {
      if (!isFiniteNumber(spec.amount) || spec.amount < 0) {
        return fail("invalid-penalty", "penalty fixed_amount.amount must be a non-negative number");
      }
      return { spec: spec.amount === 0 ? null : { kind: "fixed_amount", amount: spec.amount } };
    }
    if (spec.kind === "daily_rate") {
      if (!isFiniteNumber(spec.daily_rate) || spec.daily_rate < 0) {
        return fail("invalid-penalty", "penalty daily_rate.daily_rate must be a non-negative number");
      }
      return { spec: spec.daily_rate === 0 ? null : { kind: "daily_rate", daily_rate: spec.daily_rate } };
    }
  }
  return fail("invalid-penalty", "penalty must be a non-negative number or a {kind,…} spec");
}

/**
 * 按 interest-rules/v1 计算单利分段利息与违约金。
 * 任何输入校验失败都返回 {ok:false}，不产生半截金额。
 */
export function calculateInterest(input: ClaimsInterestInput): ClaimsInterestResult {
  if (!isFiniteNumber(input.principal) || input.principal < 0) {
    return fail("invalid-principal", "principal must be a non-negative number");
  }
  const principal = input.principal;

  if (input.interest_start === undefined || input.interest_start === null || input.interest_start === "") {
    return fail("missing-interest-start", "interest_start is required");
  }
  if (input.interest_end === undefined || input.interest_end === null || input.interest_end === "") {
    return fail("missing-interest-end", "interest_end is required");
  }
  const startDay = parseDay(input.interest_start);
  if (!startDay) return fail("invalid-interest-start", "interest_start must be a calendar date");
  const endDay = parseDay(input.interest_end);
  if (!endDay) return fail("invalid-interest-end", "interest_end must be a calendar date");
  if (endDay.epochDay <= startDay.epochDay) {
    return fail("interest-end-not-after-start", "interest_end must be after interest_start");
  }

  if (input.interest_method !== undefined && input.interest_method !== null && input.interest_method !== "simple") {
    return fail("unsupported-interest-method", "interest_method must be simple (interest-rules/v1)");
  }

  if (!Array.isArray(input.rate_segments) || input.rate_segments.length === 0) {
    return fail("empty-rate-segments", "rate_segments must contain at least one segment");
  }

  const segments: CalculatedInterestSegment[] = [];
  for (const [index, raw] of input.rate_segments.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("invalid-rate-segment", "rate_segments entries must be objects", index);
    }
    const seg = raw as Record<string, unknown>;
    const segStart = parseDay(seg.start);
    const segEnd = parseDay(seg.end);
    if (!segStart || !segEnd) {
      return fail("invalid-rate-segment", "segment start/end must be calendar dates", index);
    }
    if (segEnd.epochDay <= segStart.epochDay) {
      return fail("invalid-rate-segment", "segment end must be after segment start", index);
    }
    if (!isFiniteNumber(seg.annual_rate) || seg.annual_rate < 0) {
      return fail("invalid-rate-segment", "segment annual_rate must be a non-negative number", index);
    }
    const days = segEnd.epochDay - segStart.epochDay;
    const interest = roundCents((principal * seg.annual_rate * days) / INTEREST_DAYS_PER_YEAR);
    segments.push({
      index,
      start: segStart.iso,
      end: segEnd.iso,
      days,
      base: principal,
      annual_rate: seg.annual_rate,
      interest,
    });
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].end !== segments[i + 1].start) {
      return fail(
        "rate-segments-not-contiguous",
        `segment ${i}.end (${segments[i].end}) must equal segment ${i + 1}.start (${segments[i + 1].start})`,
        i,
      );
    }
  }
  if (segments[0].start !== startDay.iso || segments[segments.length - 1].end !== endDay.iso) {
    return fail(
      "rate-segments-window-mismatch",
      "first segment must start at interest_start and last segment must end at interest_end",
    );
  }

  const penaltyNorm = normalizePenalty(input.penalty);
  if ("ok" in penaltyNorm) return penaltyNorm;
  const penalty = penaltyNorm.spec;
  const days_total = endDay.epochDay - startDay.epochDay;

  const total_interest = roundCents(segments.reduce((sum, seg) => sum + seg.interest, 0));
  const penalty_amount = penalty === null
    ? 0
    : penalty.kind === "fixed_amount"
      ? roundCents(penalty.amount)
      : roundCents(principal * penalty.daily_rate * days_total);

  return {
    ok: true,
    rule_version: INTEREST_RULES_VERSION_V1,
    interest_method: "simple",
    principal,
    interest_start: startDay.iso,
    interest_end: endDay.iso,
    days_total,
    segments,
    total_interest,
    penalty,
    penalty_amount,
    total_amount: roundCents(total_interest + penalty_amount),
  };
}
