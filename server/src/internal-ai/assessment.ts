/**
 * FV06 版本化只读成本评价：在**不改动账本结算语义**（actualCost / state / cost / 预留 / 历史 revision）
 * 的前提下，把「逐 attempt 的 provider usage × 已核价目证书 × 调用时刻的受审证据窗口」重算成
 * 可独立复核的投影。`measured_derived` 表示“按已核价目计算的金额”，不是账本 settled cost，
 * 更不是供应商实扣凭证/余额/积分换算——实扣仍未验证。
 */
import { createHash } from "node:crypto";
import { TOKEN_PLAN_PLAN_TYPE_FREE } from "@surreal-ck/shared";
import { certificateFor, TARIFFS, type Usage } from "./pricing";
import type { Attempt, MeasurementCycle } from "./store";

export const COST_ASSESSMENT_VERSION = "cost-assessment-v1";
export const COST_ASSESSMENT_CURRENCY = "USD";
export const COST_ASSESSMENT_MONEY_UNIT = "nanoUSD";

/**
 * 评价证书：显式钉死「哪张已核价目可对哪些调用做 usage 核定」。只有列进本表的
 * priceRevision × 固定 host/path/model × 证据类型 × 账户计划，才允许进入 measured_derived；
 * OpenAI 按量、Jev 等非零费率证书不建评价证书即保持 unverifiable，绝不放宽。
 */
export type CostAssessmentCertificate = {
  id: string;
  priceRevision: string;
  provider: string;
  host: string;
  path: string;
  model: string;
  accountRef: string;
  evidenceKind: "reviewed-token-plan";
  accountPlanType: string;
  checkedAt: string;
  sources: readonly string[];
};

export const COST_ASSESSMENT_CERTIFICATES: readonly CostAssessmentCertificate[] = [
  {
    // 核定基础见 evidence-review.md：官方 Token Plan 页（公测完全免费、60000 积分/5h）、
    // 官方 API 文档（max_tokens 含 reasoning ⇒ reasoning ⊆ output）、账户级 FREE 读回与配额硬顶。
    id: "sensenova-token-plan-usage-2026-10-15",
    priceRevision: "sensenova-token-plan-2026-10-10",
    provider: "openai",
    host: "token.sensenova.cn",
    path: "/v1",
    model: "sensenova-6.8-flash-lite",
    accountRef: "snv67a4f8085b59953cf4ce7af9",
    evidenceKind: "reviewed-token-plan",
    accountPlanType: TOKEN_PLAN_PLAN_TYPE_FREE,
    checkedAt: "2026-10-15",
    sources: [
      "https://platform.sensenova.cn/docs",
      "https://www.sensenova.cn/token-plan",
      "https://github.com/OpenSenseNova/SenseNova6.8/blob/main/API_CN.md",
    ],
  },
];

export type AssessmentReason =
  | "scope-excluded"
  | "price-revision-unknown"
  | "provider-mismatch"
  | "model-mismatch"
  | "actual-model-missing"
  | "actual-model-mismatch"
  | "endpoint-mismatch"
  | "account-mismatch"
  | "evidence-revision-mismatch"
  | "evidence-revision-unknown"
  | "evidence-revision-not-enabled"
  | "evidence-kind-mismatch"
  | "account-plan-not-free"
  | "evidence-window-unknown"
  | "evidence-not-covering-call"
  | "call-time-missing"
  | "measurement-cycle-unknown"
  | "measurement-cycle-evidence-mismatch"
  | "usage-missing"
  | "usage-field-missing"
  | "usage-field-invalid"
  | "usage-dimension-unknown"
  | "usage-cache-exceeds-input"
  | "usage-reasoning-exceeds-output"
  | "usage-input-over-ceiling"
  | "usage-output-over-ceiling";

export type AssessmentStatus = "measured_derived" | "unverifiable" | "uncertain";

/** unverifiable = 资格/证据层面无法证明适用；uncertain = 适用范围内但 usage 数据无法支撑数值。 */
const UNVERIFIABLE: ReadonlySet<AssessmentReason> = new Set([
  "scope-excluded", "price-revision-unknown", "provider-mismatch", "model-mismatch",
  "actual-model-missing", "actual-model-mismatch", "endpoint-mismatch", "account-mismatch",
  "evidence-revision-mismatch", "evidence-revision-unknown", "evidence-revision-not-enabled",
  "evidence-kind-mismatch", "account-plan-not-free", "evidence-window-unknown",
  "evidence-not-covering-call", "call-time-missing", "usage-dimension-unknown",
  "measurement-cycle-unknown", "measurement-cycle-evidence-mismatch",
]);

/** 授权 revision 的只读证据投影（internal_ai_revision 行，含 created_at）。 */
export type EvidenceRevision = {
  revision: number;
  state: string;
  createdAt: unknown;
  documentHash: string | null;
  evidenceKind: string | null;
  accountPlanType: string | null;
  accountRef: string | null;
  sampledAt: unknown;
  expiresAt: unknown;
  endpoint: string;
  model: string;
  priceRevision: string;
};

export type AssessmentContext = {
  cycle: (MeasurementCycle & { id: string }) | null;
  revisions: EvidenceRevision[];
};

export type AttemptCostAssessment = {
  version: string;
  status: AssessmentStatus;
  currency: typeof COST_ASSESSMENT_CURRENCY;
  /** measured_derived 时的计算金额；其余一律 null，绝不把未知当 0。 */
  costNanoUsd: number | null;
  reasons: AssessmentReason[];
  certificate: string | null;
  priceRevision: string;
  usage: Usage | null;
  evidence: { revision: number; documentHash: string; sampledAt: string; expiresAt: string } | null;
  sourceHash: string;
};

export type AssessedAttempt = {
  id: string;
  sequence: number;
  runHash: string;
  state: string;
  costAssessment: AttemptCostAssessment;
};

const USAGE_KEYS = new Set(["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]);

/** SDK 返回的 datetime 可能是 ISO string、Date 或 surrealdb DateTime；只读解析、不改原值。 */
function toMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "object" && "toDate" in value) {
    const d = (value as { toDate(): unknown }).toDate();
    if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime();
  }
  return null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function usageReasons(usage: unknown, maxInput: number, maxOutput: number): AssessmentReason[] {
  const reasons: AssessmentReason[] = [];
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    reasons.push("usage-missing");
    return reasons;
  }
  const keys = Object.keys(usage);
  if (keys.some(k => !USAGE_KEYS.has(k))) reasons.push("usage-dimension-unknown");
  const u = usage as Usage;
  let missing = false;
  for (const k of ["inputTokens", "outputTokens"] as const) {
    if (u[k] === null || u[k] === undefined) missing = true;
  }
  if (missing) reasons.push("usage-field-missing");
  let invalid = false;
  for (const k of USAGE_KEYS) {
    const v = (usage as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || (v as number) < 0)) invalid = true;
  }
  if (invalid) reasons.push("usage-field-invalid");
  if (missing || invalid) return reasons;
  const i = u.inputTokens!, o = u.outputTokens!, c = u.cachedInputTokens, r = u.reasoningTokens;
  // reasoning ⊆ output 由官方 API 文档（max_tokens 含 reasoning）与 SDK 归一化共同核定；
  // cache ⊆ input 同理。越界即数据不可信，不是“多算一点”。
  if (c !== null && c !== undefined && c > i) reasons.push("usage-cache-exceeds-input");
  if (r !== null && r !== undefined && r > o) reasons.push("usage-reasoning-exceeds-output");
  // 与 actualCost 的历史口径不同：评价层**无条件**检查 maxOutput，零费率不豁免上限。
  if (i > maxInput) reasons.push("usage-input-over-ceiling");
  if (o > maxOutput) reasons.push("usage-output-over-ceiling");
  return reasons;
}

function resolveEvidence(a: Attempt, ctx: AssessmentContext, reasons: AssessmentReason[]): { rev: EvidenceRevision; cycleExpiresMs: number | null } | null {
  if (a.measurement_cycle !== undefined && a.measurement_cycle !== null) {
    if (!ctx.cycle || a.measurement_cycle !== ctx.cycle.id) {
      reasons.push("measurement-cycle-unknown");
      return null;
    }
    const rev = ctx.revisions.find(
      r => r.revision === ctx.cycle!.enabled_revision && r.documentHash === ctx.cycle!.evidence_hash,
    );
    if (!rev) {
      reasons.push("measurement-cycle-evidence-mismatch");
      return null;
    }
    return { rev, cycleExpiresMs: toMs(ctx.cycle.expires_at) };
  }
  const started = toMs(a.started_at);
  if (started === null) {
    reasons.push("call-time-missing");
    return null;
  }
  let rev: EvidenceRevision | null = null;
  let revMs = -Infinity;
  for (const r of ctx.revisions) {
    const ms = toMs(r.createdAt);
    if (ms !== null && ms <= started && ms > revMs) {
      rev = r;
      revMs = ms;
    }
  }
  if (!rev) {
    reasons.push("evidence-revision-unknown");
    return null;
  }
  // reserve 只在 enabled 下发生；若调用时刻重建出的最新 revision 不是 enabled，说明记录链不可信。
  if (rev.state !== "enabled") {
    reasons.push("evidence-revision-not-enabled");
    return null;
  }
  return { rev, cycleExpiresMs: null };
}

export function assessAttempt(a: Attempt, ctx: AssessmentContext): AttemptCostAssessment {
  const reasons: AssessmentReason[] = [];
  const tariff = TARIFFS.find(t => t.revision === a.price_revision);
  if (!tariff) reasons.push("price-revision-unknown");
  const cert = tariff
    ? COST_ASSESSMENT_CERTIFICATES.find(c => c.priceRevision === tariff.revision)
    : undefined;
  if (tariff && !cert) reasons.push("scope-excluded");

  if (cert) {
    if (a.provider !== cert.provider) reasons.push("provider-mismatch");
    if (a.model !== cert.model) reasons.push("model-mismatch");
    if (a.actual_model === null || a.actual_model === undefined) reasons.push("actual-model-missing");
    else if (a.actual_model !== cert.model) reasons.push("actual-model-mismatch");
  }

  let evidence: AttemptCostAssessment["evidence"] = null;
  if (cert) {
    const resolved = resolveEvidence(a, ctx, reasons);
    if (resolved) {
      const { rev, cycleExpiresMs } = resolved;
      if (rev.model !== cert.model || rev.priceRevision !== cert.priceRevision) reasons.push("evidence-revision-mismatch");
      if (certificateFor(rev.endpoint, cert.model)?.revision !== cert.priceRevision) reasons.push("endpoint-mismatch");
      if (rev.accountRef !== cert.accountRef) reasons.push("account-mismatch");
      if (rev.evidenceKind !== cert.evidenceKind) reasons.push("evidence-kind-mismatch");
      if (rev.accountPlanType !== cert.accountPlanType) reasons.push("account-plan-not-free");
      const sampledMs = toMs(rev.sampledAt);
      let expiresMs = toMs(rev.expiresAt);
      if (cycleExpiresMs !== null) expiresMs = expiresMs === null ? cycleExpiresMs : Math.min(expiresMs, cycleExpiresMs);
      if (sampledMs === null || expiresMs === null) {
        reasons.push("evidence-window-unknown");
      } else if (!reasons.includes("call-time-missing")) {
        const started = toMs(a.started_at);
        if (started === null) reasons.push("call-time-missing");
        else {
          const ended = toMs(a.ended_at) ?? started;
          if (started < sampledMs || ended > expiresMs) reasons.push("evidence-not-covering-call");
        }
      }
      evidence = {
        revision: rev.revision,
        documentHash: rev.documentHash ?? "",
        sampledAt: iso(sampledMs) ?? "",
        expiresAt: iso(toMs(rev.expiresAt)) ?? "",
      };
    }
  }

  // usage 校验独立于资格判断：即使 scope 外也如实报告数据问题。上限只在命中证书时按其边界执行。
  const usageIsObject = a.usage !== null && typeof a.usage === "object" && !Array.isArray(a.usage);
  if (a.usage_source !== "provider" || !usageIsObject) {
    reasons.push("usage-missing");
  } else if (cert) {
    reasons.push(...usageReasons(a.usage, tariff!.maxInput, tariff!.maxOutput));
  } else {
    reasons.push(...usageReasons(a.usage, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  }

  const status: AssessmentStatus = reasons.length === 0
    ? "measured_derived"
    : reasons.some(r => UNVERIFIABLE.has(r)) ? "unverifiable" : "uncertain";

  let costNanoUsd: number | null = null;
  if (status === "measured_derived") {
    const u = a.usage as Usage;
    const i = u.inputTokens!, o = u.outputTokens!, c = u.cachedInputTokens ?? 0;
    // reasoning 已在 output 内（官方明示），不二次计费；公式与 actualCost 同形但由评价证书约束。
    const cost = (i - c) * tariff!.input + c * tariff!.cached + o * tariff!.output;
    costNanoUsd = Number.isSafeInteger(cost) ? cost : null;
  }

  // sourceHash：评价所消费的不可变投影，QA 可对同一投影复算验证一致性。
  const sourceHash = createHash("sha256").update(JSON.stringify({
    v: COST_ASSESSMENT_VERSION,
    id: String(a.id), sequence: a.sequence, runHash: a.run_hash, stage: a.stage, state: a.state,
    provider: a.provider, model: a.model, actualModel: a.actual_model, priceRevision: a.price_revision,
    usage: a.usage, usageSource: a.usage_source, startedAt: iso(toMs(a.started_at)), endedAt: iso(toMs(a.ended_at)),
    measurementCycle: a.measurement_cycle ?? null,
    certificate: cert?.id ?? null, evidence,
    reasons, status, costNanoUsd,
  })).digest("hex");

  return {
    version: COST_ASSESSMENT_VERSION,
    status,
    currency: COST_ASSESSMENT_CURRENCY,
    costNanoUsd,
    reasons,
    certificate: cert?.id ?? null,
    priceRevision: a.price_revision,
    usage: usageIsObject ? (a.usage as Usage) : null,
    evidence,
    sourceHash,
  };
}

export type RunCostRollup = {
  runHash: string;
  attemptIds: string[];
  attemptCount: number;
  measuredCount: number;
  unknownCallCount: number;
  knownSubtotalNanoUsd: number;
  status: "assessed" | "unassessed";
  totalCostNanoUsd: number | null;
  reasons: AssessmentReason[];
};

export type CostAssessmentAggregate = {
  version: string;
  currency: typeof COST_ASSESSMENT_CURRENCY;
  moneyUnit: typeof COST_ASSESSMENT_MONEY_UNIT;
  attemptCount: number;
  runCount: number;
  measuredCount: number;
  /** 未核定调用数（unverifiable + uncertain）。 */
  unknownCallCount: number;
  /** 含任一未核定调用的 run 数。 */
  unknownRunCount: number;
  /** 仅 measured_derived 的分项和；不是总成本的替身。 */
  knownSubtotalNanoUsd: number;
  status: "assessed" | "unassessed";
  totalCostNanoUsd: number | null;
  reasonCounts: Record<string, number>;
  runs: RunCostRollup[];
  perSuccessfulTask: { costNanoUsd: number | null; successfulTasks: number | null; reason: string | null };
};

/** run/路径聚合：唯一 attempt ID 去重；任一覆盖缺口 ⇒ run 与整体总成本不核定，绝不用已知小计顶替。 */
export function aggregateAssessments(
  attempts: AssessedAttempt[],
  options?: { successfulTasks?: number },
): CostAssessmentAggregate {
  const seen = new Set<string>();
  const runs = new Map<string, RunCostRollup>();
  const reasonCounts: Record<string, number> = {};
  let attemptCount = 0;
  let measuredCount = 0;
  let knownSubtotalNanoUsd = 0;
  for (const a of attempts) {
    if (seen.has(a.id)) continue; // 分页重叠/同 attempt 重复出现不扩分母
    seen.add(a.id);
    attemptCount += 1;
    const ok = a.costAssessment.status === "measured_derived" && a.costAssessment.costNanoUsd !== null;
    if (ok) {
      measuredCount += 1;
      knownSubtotalNanoUsd += a.costAssessment.costNanoUsd!;
    }
    for (const r of a.costAssessment.reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
    let run = runs.get(a.runHash);
    if (!run) {
      run = { runHash: a.runHash, attemptIds: [], attemptCount: 0, measuredCount: 0, unknownCallCount: 0, knownSubtotalNanoUsd: 0, status: "assessed", totalCostNanoUsd: 0, reasons: [] };
      runs.set(a.runHash, run);
    }
    run.attemptIds.push(a.id);
    run.attemptCount += 1;
    if (ok) {
      run.measuredCount += 1;
      run.knownSubtotalNanoUsd += a.costAssessment.costNanoUsd!;
    } else {
      run.unknownCallCount += 1;
      for (const r of a.costAssessment.reasons) if (!run.reasons.includes(r)) run.reasons.push(r);
      run.status = "unassessed";
      run.totalCostNanoUsd = null;
    }
  }
  const runList = [...runs.values()].sort((x, y) => x.runHash.localeCompare(y.runHash));
  const unknownRunCount = runList.filter(r => r.status === "unassessed").length;
  const assessed = runList.every(r => r.status === "assessed");
  const totalCostNanoUsd = assessed ? knownSubtotalNanoUsd : null;

  let perSuccessfulTask: CostAssessmentAggregate["perSuccessfulTask"];
  const n = options?.successfulTasks;
  if (n === undefined) {
    perSuccessfulTask = { costNanoUsd: null, successfulTasks: null, reason: "successful-tasks-not-provided" };
  } else if (!assessed) {
    perSuccessfulTask = { costNanoUsd: null, successfulTasks: n, reason: "cost-unassessed" };
  } else if (n === 0) {
    // 零成功路径：分母为 0 时每成功任务成本保持 null，原因稳定为 undefined_zero_success。
    perSuccessfulTask = { costNanoUsd: null, successfulTasks: 0, reason: "undefined_zero_success" };
  } else {
    perSuccessfulTask = { costNanoUsd: totalCostNanoUsd! / n, successfulTasks: n, reason: null };
  }

  return {
    version: COST_ASSESSMENT_VERSION,
    currency: COST_ASSESSMENT_CURRENCY,
    moneyUnit: COST_ASSESSMENT_MONEY_UNIT,
    attemptCount,
    runCount: runList.length,
    measuredCount,
    unknownCallCount: attemptCount - measuredCount,
    unknownRunCount,
    knownSubtotalNanoUsd,
    status: assessed ? "assessed" : "unassessed",
    totalCostNanoUsd,
    reasonCounts,
    runs: runList,
    perSuccessfulTask,
  };
}
