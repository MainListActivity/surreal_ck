import { createHash } from "node:crypto";
import {
  MAGPIE_B_ENVELOPE, MAGPIE_CAPACITY_SCOPE, MAGPIE_LOCAL_FRESHNESS_SECONDS, MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION,
  MAGPIE_WINDOW_LEGACY_PREFIXES, MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS,
  type MagpieRemoteWindowCreate, type MagpieWindowCreate, type MagpieWindowPriceBasis,
} from "@surreal-ck/shared";
import { DEFAULT_GATE_LIMITS } from "../../ai/office/employee-gates";
import type { RuntimeIdentity } from "../../ai/mastra/agents/model-config";
import { actualCost, tariffFor, TARIFFS, worstCost, type Tariff, type Usage } from "./pricing";
import type { RecordId } from "surrealdb";

/** 窗口行的数据库形状（snake_case，与 039/042 schema 一致）。 */
export type WindowRow = {
  id: RecordId; activity: string; approval_digest: string; approval_task: string; account_ref: string;
  evidence_expires_at: string; attempt_limit: number; source_budget_nano_usd: number; per_attempt_nano_usd: number;
  envelope?: string;
  attempts: number; reserved: number; spent: number; status: string; revision: number;
  route_revision: string | null; route_digest: string | null; requested_model: string; served_model: string;
  endpoint: string; account_binding: string; price_revision: string; price_basis: MagpieWindowPriceBasis;
  free_evidence_hash: string | null; amortized_nano_usd: number | null; marginal_nano_usd: number | null;
  max_output_tokens: number; sampled_at: string; route_expires_at: string | null;
  capacity_database: string; capacity_tables: number; capacity_fields: number; capacity_records: number;
  capacity_ttl_seconds: number; capacity_destructive: boolean; capacity_source: string;
  idempotency_key: string; payload_hash: string; operator: string; reason: string;
  created_at: unknown; bound_at: unknown;
  // 042 远端分层字段：NONE（DB 缺失）一律按 null 处理，视为 v1 契约行。
  contract_version: string | null; evidence_version: string | null;
  observation_captured_at: string | null; observation_digest: string | null;
  routing_configuration_verified: boolean | null; route_provider: string | null;
  route_gaps: Array<{ field: string; reason: string }> | null;
  expiry_basis: string | null; local_freshness_expires_at: string | null; source_expires_at: string[] | null;
  pricing_reviewed: boolean | null; pricing_evidence_revision: string | null;
};

/**
 * 窗口创建的内部归一形状：v1 与远端 v2 走同一条持久化事务、同一读回投影、同一请求门禁。
 * v1 行 remote=null 且 route 字段非空；v2 行 route.revision/digest/expiresAt 可为 null。
 */
export type WindowCreateRequest = {
  activity: string; approvalDigest: string; approvalTask: string; accountRef: string;
  evidenceExpiresAt: string; sourceBudgetAttempts: number; sourceBudgetNanoUsd: number; perAttemptNanoUsd: number;
  route: {
    revision: string | null; digest: string | null; requestedModel: string; servedModel: string;
    endpoint: string; accountBinding: string;
    priceRevision: string; priceBasis: MagpieWindowPriceBasis;
    freeEvidenceHash: string | null; amortizedNanoUsd: number | null; marginalNanoUsd: number | null;
    maxOutputTokens: number; sampledAt: string; expiresAt: string | null; provider: string | null;
  };
  capacity: MagpieWindowCreate["capacity"];
  idempotencyKey: string; reason: string; contractVersion: string;
  remote: {
    evidenceVersion: string; observationCapturedAt: string; observationDigest: string;
    routingConfigurationVerified: boolean; gaps: Array<{ field: string; reason: string }>;
    expiryBasis: string; localFreshnessExpiresAt: string; sourceExpiresAt: string[];
    pricingReviewed: boolean; pricingEvidenceRevision: string | null;
  } | null;
};

/** 带稳定错误码的拒绝：路由层映射为 4xx，调用方不解析自由文本。 */
export class WindowDenied extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WindowDenied"; }
}
const deny: (code: string, message: string) => never = (code, message) => { throw new WindowDenied(code, message); };

/** 稳定序列化：键排序后再哈希，保证同一载荷跨进程得到同一 payload_hash。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const payloadHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** 旧周期/旧批准/旧 proof 命中：任何一项出现即拒绝，禁止换字段复活或延长期。 */
export function legacyHit(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) continue;
    const lowered = value.toLowerCase();
    const hit = MAGPIE_WINDOW_LEGACY_PREFIXES.find(prefix => lowered.startsWith(prefix) || lowered.includes(prefix));
    if (hit) return hit;
  }
  return null;
}

const parseInstant = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** 9e44a95d 容量 scope 的纯校验；只记录声明，不创建任何容量。 */
export function validateCapacity(scope: MagpieWindowCreate["capacity"]): void {
  if (scope.database !== MAGPIE_CAPACITY_SCOPE.database) deny("magpie-window-capacity-out-of-scope", "容量库不在 9e44a95d 批准 scope 内");
  if (scope.entityTables < MAGPIE_CAPACITY_SCOPE.minEntityTables || scope.entityTables > MAGPIE_CAPACITY_SCOPE.maxEntityTables) deny("magpie-window-capacity-out-of-scope", "entity tables 超出 3..5");
  if (scope.fieldsPerTable > MAGPIE_CAPACITY_SCOPE.maxFieldsPerTable) deny("magpie-window-capacity-out-of-scope", "每表字段超出 23");
  if (scope.recordsPerTable > MAGPIE_CAPACITY_SCOPE.maxRecordsPerTable) deny("magpie-window-capacity-out-of-scope", "每表记录超出 24");
  if (scope.ttlSeconds > MAGPIE_CAPACITY_SCOPE.maxTtlSeconds) deny("magpie-window-capacity-out-of-scope", "容量 TTL 超出 24h");
  if (scope.destructive !== false) deny("magpie-window-capacity-out-of-scope", "容量声明不得为破坏性");
  if (!scope.source.includes("9e44a95d")) deny("magpie-window-capacity-out-of-scope", "容量必须引用 9e44a95d 有效来源");
}

function endpointParts(endpoint: string): { protocol: string; host: string; path: string; key: string } {
  let url: URL;
  try { url = new URL(endpoint); } catch { return deny("magpie-window-route-invalid", "端点不是合法 URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.pathname) deny("magpie-window-route-invalid", "端点协议/凭据/路径不合法");
  return { protocol: url.protocol, host: url.host, path: url.pathname.replace(/\/$/, ""), key: `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}` };
}

/** 路由声明自洽性：价格依据必须有来源，错账号/错价目/矛盾披露一律拒绝。 */
export function validateRoute(input: MagpieWindowCreate): void {
  const route = input.route;
  const parts = endpointParts(route.endpoint);
  if (input.accountRef !== route.accountBinding) deny("magpie-window-account-mismatch", "批准账号与路由账号绑定不一致");
  if (parseInstant(route.expiresAt) <= Date.now()) deny("magpie-window-route-expired", "路由证据已过期");
  if (!Number.isFinite(parseInstant(route.sampledAt))) deny("magpie-window-route-invalid", "路由采样时间不合法");
  if (route.priceBasis === "free-evidence") {
    if (!route.freeEvidenceHash) deny("magpie-window-price-basis-invalid", "零费率必须提供真实免费证据 hash");
    if (route.amortizedNanoUsd !== undefined || route.marginalNanoUsd !== undefined) deny("magpie-window-price-basis-invalid", "零费率不得同时披露分摊/边际成本");
  }
  if (route.priceBasis === "per-token") {
    const tariff = TARIFFS.find(t => t.revision === route.priceRevision);
    if (!tariff) return deny("magpie-window-price-revision-unavailable", "价目修订没有已核价目证书");
    if (tariff.model !== route.servedModel) return deny("magpie-window-price-revision-unavailable", "价目模型与 servedModel 不一致");
    if (parts.protocol !== "https:" || !tariffFor(tariff.provider, route.servedModel, route.endpoint)) return deny("magpie-window-price-revision-unavailable", "价目证书的协议/主机/路径不匹配");
  }
  if (route.priceBasis === "subscription-amortized" && route.amortizedNanoUsd === undefined && route.marginalNanoUsd === undefined) {
    deny("magpie-window-price-basis-invalid", "订阅分摊/边际成本必须至少披露一项");
  }
}

/**
 * 包络/预算门禁（v1 与远端 v2 的单一来源）：旧周期/旧批准/旧 proof、证据期、
 * USD 继承上限与剩余次数。包络剩余算法（30 − 全部历史已用 − 已承诺）保持
 * 全局唯一一份；B 档独立包络（73a769c4）演进时只改这里，不复制第二套计费。
 */
/**
 * 包络/预算门禁（v1 / B 档包络 / 远端 v2 的单一来源）：旧周期/旧批准/旧 proof、证据期、
 * USD 继承上限与剩余次数。包络剩余算法保持全局唯一一份；B 档独立包络（73a769c4）
 * 与远端 v2（本线）都只复用这里，不复制第二套计费。
 */
export type WindowEnvelopeGate = Pick<MagpieWindowCreate, "approvalDigest" | "approvalTask" | "accountRef" | "evidenceExpiresAt" | "sourceBudgetAttempts" | "sourceBudgetNanoUsd" | "perAttemptNanoUsd" | "envelope">;

export function validateWindowEnvelope(
  input: WindowEnvelopeGate,
  ctx: { totalUsed: number; committedAttempts: number; activityTotalLimit: number; activityPerAttemptLimit: number; envelopeUsed?: number; envelopeCommitted?: number; envelopeCommittedNanoUsd?: number; envelopeSpentNanoUsd?: number; envelopeReservedNanoUsd?: number; now?: number },
): void {
  const hit = legacyHit(input.approvalDigest, input.approvalTask, input.accountRef);
  if (hit) deny("magpie-window-legacy-rejected", `输入命中旧周期/旧批准/旧 proof 前缀 ${hit}`);
  const expires = parseInstant(input.evidenceExpiresAt);
  const now = ctx.now ?? Date.now();
  if (input.envelope === MAGPIE_B_ENVELOPE.id && now >= Date.parse(MAGPIE_B_ENVELOPE.expiresAt)) deny("magpie-window-envelope-expired", "B 档包络已过期");
  if (!Number.isFinite(expires) || expires <= now) deny("magpie-window-evidence-expired", "证据期必须晚于当前时间");
  if (input.envelope !== MAGPIE_B_ENVELOPE.id) {
    if (input.sourceBudgetNanoUsd > ctx.activityTotalLimit) deny("magpie-window-cap-inheritance", "源预算 USD 不得超过既有活动总上限");
    if (input.perAttemptNanoUsd > ctx.activityPerAttemptLimit) deny("magpie-window-cap-inheritance", "单次预算 USD 不得超过既有活动单次上限");
  }
  if (input.envelope === MAGPIE_B_ENVELOPE.id) {
    if (now >= Date.parse(MAGPIE_B_ENVELOPE.expiresAt) || expires > Date.parse(MAGPIE_B_ENVELOPE.expiresAt)) deny("magpie-window-envelope-expired", "B 档包络已过期或窗口证据期超出包络期限");
    const committedUsd = (ctx.envelopeCommittedNanoUsd ?? 0) + (ctx.envelopeReservedNanoUsd ?? 0) + (ctx.envelopeSpentNanoUsd ?? 0);
    if (input.sourceBudgetNanoUsd > MAGPIE_B_ENVELOPE.totalNanoUsd || input.perAttemptNanoUsd > MAGPIE_B_ENVELOPE.perAttemptNanoUsd || input.sourceBudgetAttempts > MAGPIE_B_ENVELOPE.maxAttempts
      || committedUsd + input.sourceBudgetNanoUsd > MAGPIE_B_ENVELOPE.totalNanoUsd) {
      deny("magpie-window-envelope-cap-exceeded", "请求超过 B 档包络次数或 USD 上限");
    }
    const remaining = MAGPIE_B_ENVELOPE.maxAttempts - (ctx.envelopeUsed ?? 0) - (ctx.envelopeCommitted ?? 0);
    if (remaining <= 0 || input.sourceBudgetAttempts > remaining) deny("magpie-window-remaining-insufficient", `B 档剩余可用次数不足：请求 ${input.sourceBudgetAttempts}，可用 ${Math.max(0, remaining)}`);
  } else {
    const remaining = MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS - ctx.totalUsed - ctx.committedAttempts;
    if (remaining <= 0 || input.sourceBudgetAttempts > remaining) deny("magpie-window-remaining-insufficient", `剩余可用次数不足：请求 ${input.sourceBudgetAttempts}，可用 ${Math.max(0, remaining)}`);
  }
}

/**
 * 创建窗口的全部拒绝条件。`totalUsed` = 全部历史 attempt 数（含 failed/uncertain），
 * `committedAttempts` = 现有 active 窗口 attempt_limit 之和；两者共同保证不重领 30。
 */
export function validateWindowCreate(input: MagpieWindowCreate, ctx: { totalUsed: number; committedAttempts: number; activityTotalLimit: number; activityPerAttemptLimit: number; envelopeUsed?: number; envelopeCommitted?: number; envelopeCommittedNanoUsd?: number; envelopeSpentNanoUsd?: number; envelopeReservedNanoUsd?: number; now?: number }): void {
  validateWindowEnvelope(input, ctx);
  validateCapacity(input.capacity);
  validateRoute(input);
}

const endpointKey = (endpoint: string): string | null => {
  try { return endpointParts(endpoint).key; } catch { return null; }
};

/**
 * 远端窗口 v2：校验后产出与 v1 完全同构的持久化请求（同一事务/读回/CAS/门禁）。
 * 校验顺序：包络与容量 → 账号身份 → 受控运行配置交叉核对 → null+gap 一一对应 →
 * 观测与本地新鲜度 → 已批请求边界 → 价格派生（unknown 闭锁）。
 */
export function buildRemoteWindowRequest(
  input: MagpieRemoteWindowCreate,
  ctx: { totalUsed: number; committedAttempts: number; activityTotalLimit: number; activityPerAttemptLimit: number; runtime: RuntimeIdentity | null },
): WindowCreateRequest {
  validateWindowEnvelope(input, ctx);
  validateCapacity(input.capacity);
  const evidence = input.evidence;
  if (input.accountRef !== evidence.accountRef || input.accountRef !== evidence.accountBinding) {
    deny("magpie-window-account-mismatch", "窗口账号与远端证据账号绑定不一致");
  }
  // 受控运行配置交叉核对：内部 AI 未接线或配置为空一律拒绝，不从证据缺字段猜值。
  const runtime = ctx.runtime;
  if (!runtime || !runtime.modelId.trim() || !runtime.endpoint.trim()) {
    deny("magpie-window-runtime-unavailable", "受控运行配置不可用，无法交叉核对实际路由");
  }
  if (runtime.modelId !== evidence.route.group) deny("magpie-window-route-mismatch", "受控运行配置的模型与证据路由组不一致");
  if (evidence.source.model !== evidence.route.group && !evidence.source.model.endsWith(`/${evidence.route.group}`)) {
    deny("magpie-window-route-mismatch", "证据来源模型与路由组不一致");
  }
  if (endpointKey(runtime.endpoint) === null || endpointKey(runtime.endpoint) !== endpointKey(evidence.source.endpoint)) {
    deny("magpie-window-endpoint-mismatch", "受控运行配置端点与证据来源端点不一致");
  }
  // null+gap 一一对应：null 字段必须有缺口声明、非 null 字段不得有，路由层与顶层一致。
  const routeGaps = new Map(evidence.route.gaps.map(g => [g.field, g.reason]));
  const topGaps = new Map(evidence.gaps.map(g => [g.field, g.reason]));
  const gapFields = ["revision", "digest", "expiresAt"] as const;
  if (routeGaps.size !== evidence.route.gaps.length || topGaps.size !== evidence.gaps.length) {
    deny("magpie-window-gap-inconsistent", "缺口声明存在重复字段");
  }
  if ([...routeGaps.keys()].some(field => !(gapFields as readonly string[]).includes(field))
    || [...topGaps.keys()].some(field => !gapFields.some(f => field === `route.${f}`))) {
    deny("magpie-window-gap-inconsistent", "缺口声明只能覆盖 route.revision/digest/expiresAt");
  }
  for (const field of gapFields) {
    const isNull = evidence.route[field] === null;
    const topField = `route.${field}`;
    if (isNull !== routeGaps.has(field) || isNull !== topGaps.has(topField)) {
      deny("magpie-window-gap-inconsistent", `路由字段 ${field} 的 null 与缺口声明不一一对应`);
    }
    if (isNull && routeGaps.get(field) !== topGaps.get(topField)) {
      deny("magpie-window-gap-inconsistent", `路由缺口 ${field} 与顶层缺口 ${topField} 的原因不一致`);
    }
  }
  // 观测与本地新鲜度：采集时刻不得来自未来；证据期 = 采集 + 7200s 本地策略，
  // 只落在观测/expiry 层，绝不写入远端 route.expiresAt。
  const captured = parseInstant(evidence.observation.capturedAt);
  if (!Number.isFinite(captured) || captured > Date.now()) deny("magpie-window-observation-invalid", "观测采集时刻不合法或来自未来");
  const freshness = captured + MAGPIE_LOCAL_FRESHNESS_SECONDS * 1000;
  if (parseInstant(evidence.expiry.localFreshnessExpiresAt) !== freshness) {
    deny("magpie-window-observation-invalid", `本地新鲜度期限必须等于采集时刻+${MAGPIE_LOCAL_FRESHNESS_SECONDS}s`);
  }
  if (evidence.expiry.expiresAt !== evidence.expiry.localFreshnessExpiresAt || input.evidenceExpiresAt !== evidence.expiry.expiresAt) {
    deny("magpie-window-observation-invalid", "证据期必须等于本地新鲜度期限，不得延长或另立期限");
  }
  const windowExpiry = parseInstant(input.evidenceExpiresAt);
  const remoteBounds = [...evidence.expiry.sourceExpiresAt, ...(evidence.route.expiresAt === null ? [] : [evidence.route.expiresAt])];
  for (const bound of remoteBounds) {
    if (parseInstant(bound) < windowExpiry) deny("magpie-window-observation-invalid", "证据期不得超过远端给出的到期时刻");
  }
  // 已批请求边界：输出上限不得越过产品单次调用天花板；预算不得越过证据包络。
  if (input.maxOutputTokens > DEFAULT_GATE_LIMITS.maxOutputTokensPerCall) {
    deny("magpie-window-request-bound-exceeded", `输出上限不得超过产品单次调用天花板 ${DEFAULT_GATE_LIMITS.maxOutputTokensPerCall}`);
  }
  if (input.sourceBudgetAttempts > evidence.budget.maxAttempts) deny("magpie-window-envelope-exceeded", "窗口次数超过已批包络 maxAttempts");
  if (input.sourceBudgetNanoUsd > evidence.budget.totalNanoUsd) deny("magpie-window-envelope-exceeded", "窗口总额超过已批包络 totalNanoUsd");
  if (input.perAttemptNanoUsd > evidence.budget.perAttemptNanoUsd) deny("magpie-window-envelope-exceeded", "窗口单次预算超过已批包络 perAttemptNanoUsd");
  // 价格派生（独立硬门禁）：reviewed=false 的目录 0/0 一律 unknown（请求门禁闭锁），
  // 永不自动等于 free-evidence；reviewed=true 也必须命中产品已核价目证书
  // （模型 + 协议/主机/路径）才可用 per-token，否则拒绝。
  let priceBasis: MagpieWindowPriceBasis = "unknown";
  let priceRevision = "unknown";
  let outputBound = input.maxOutputTokens;
  if (evidence.pricing.reviewed) {
    const matched = TARIFFS.find(t => t.model === evidence.route.servedModel && tariffFor(t.provider, evidence.route.servedModel, runtime.endpoint));
    if (!matched) deny("magpie-window-price-revision-unavailable", "已复核价目没有匹配实际路由（模型/主机/路径）的证书");
    // 输出上限与已批证书交叉核对：per-token 真正生效的封顶与 worstCost 预留都用证书 maxOutput
    // （windowTariff → gate → model.ts 封顶、windowAmount），冻结值必须与证书一致；
    // 入参不等即拒绝，不从调用方入参猜输出上限。天花板检查在本段之前——证书 maxOutput
    // 高于产品天花板时该证书组合继续拒绝，不扩大天花板。
    if (input.maxOutputTokens !== matched.maxOutput) {
      deny("magpie-window-request-bound-mismatch", `输出上限必须等于已核证书 maxOutput ${matched.maxOutput}`);
    }
    priceBasis = "per-token";
    priceRevision = matched.revision;
    outputBound = matched.maxOutput;
  }
  return {
    activity: input.activity, approvalDigest: input.approvalDigest, approvalTask: input.approvalTask,
    accountRef: input.accountRef, evidenceExpiresAt: input.evidenceExpiresAt,
    sourceBudgetAttempts: input.sourceBudgetAttempts, sourceBudgetNanoUsd: input.sourceBudgetNanoUsd,
    perAttemptNanoUsd: input.perAttemptNanoUsd,
    route: {
      revision: evidence.route.revision, digest: evidence.route.digest,
      requestedModel: runtime.modelId, servedModel: evidence.route.servedModel,
      endpoint: runtime.endpoint, accountBinding: evidence.accountBinding,
      priceRevision, priceBasis, freeEvidenceHash: null, amortizedNanoUsd: null, marginalNanoUsd: null,
      maxOutputTokens: outputBound, sampledAt: evidence.route.sampledAt,
      expiresAt: evidence.route.expiresAt, provider: runtime.providerId,
    },
    capacity: input.capacity, idempotencyKey: input.idempotencyKey, reason: input.reason,
    contractVersion: MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION,
    remote: {
      evidenceVersion: evidence.version, observationCapturedAt: evidence.observation.capturedAt,
      observationDigest: evidence.observation.digest, routingConfigurationVerified: false,
      gaps: evidence.route.gaps.map(g => ({ field: g.field, reason: g.reason })),
      expiryBasis: evidence.expiry.basis, localFreshnessExpiresAt: evidence.expiry.localFreshnessExpiresAt,
      sourceExpiresAt: [...evidence.expiry.sourceExpiresAt],
      pricingReviewed: evidence.pricing.reviewed, pricingEvidenceRevision: evidence.pricing.priceRevision,
    },
  };
}

export type WindowCostAssessment = {
  cost: number | null;
  status: "free-evidence" | "assessed" | "usage-missing" | "invalid-usage" | "route-drift" | "unassessed" | "unknown";
  routeDrift: boolean;
  amortized: number | null;
  marginal: number | null;
};

export function usageValid(usage: Usage | null): usage is { inputTokens: number; outputTokens: number; cachedInputTokens: number | null; reasoningTokens: number | null } {
  if (!usage) return false;
  const { inputTokens: i, outputTokens: o, cachedInputTokens: c, reasoningTokens: r } = usage;
  const ok = (n: number | null) => n === null || (Number.isSafeInteger(n) && n >= 0);
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(o) || (i as number) < 0 || (o as number) < 0) return false;
  if (!ok(c) || !ok(r)) return false;
  if (c !== null && c > (i as number)) return false;
  if (r !== null && r > (o as number)) return false;
  return true;
}

/** 窗口自带的价目横截面：per-token 复用已核证书；free/amortized 用窗口冻结的最大输出上限。 */
export function windowTariff(window: WindowRow): Tariff {
  const host = endpointParts(window.endpoint).host;
  if (window.price_basis === "per-token") {
    const tariff = TARIFFS.find(t => t.revision === window.price_revision);
    if (!tariff || tariff.model !== window.served_model || !tariffFor(tariff.provider, window.served_model, window.endpoint)) {
      return deny("magpie-window-price-revision-unavailable", "窗口价目修订不可用");
    }
    return tariff;
  }
  if (window.price_basis === "unknown") return deny("magpie-window-price-unassessed", "未知成本窗口禁止发起调用");
  return {
    revision: window.price_revision, provider: "openai", model: window.served_model, host,
    source: window.price_basis === "free-evidence" ? `free-evidence:${window.free_evidence_hash}` : `subscription:${window.account_binding}`,
    checkedAt: window.sampled_at, maxInput: 10_000_000, maxOutput: window.max_output_tokens,
    input: 0, cached: 0, output: 0,
  };
}

/** 预留金额：free=0；per-token=最坏成本；amortized=单次上限（保守占用）；unknown 拒绝。 */
export function windowAmount(window: WindowRow): number {
  if (window.price_basis === "free-evidence") return 0;
  if (window.price_basis === "per-token") return worstCost(windowTariff(window));
  if (window.price_basis === "subscription-amortized") return window.per_attempt_nano_usd;
  return deny("magpie-window-price-unassessed", "未知成本窗口禁止发起调用");
}

/** 运行时路由必须与窗口冻结快照一致；provider/model/scheme/host/port/path 任一不同即漂移。 */
export function routeMatches(window: WindowRow, provider: string, model: string, endpoint: string): boolean {
  // v2 行冻结受控 provider；v1 行（route_provider 为 NONE）保持旧 openai 硬规则不变。
  const expectedProvider = window.route_provider?.trim() ? window.route_provider : "openai";
  if (provider !== expectedProvider || model !== window.requested_model) return false;
  let runtime: { key: string };
  try { runtime = endpointParts(endpoint); } catch { return false; }
  return runtime.key === endpointParts(window.endpoint).key;
}

/**
 * 逐请求成本核定。顺序固定：servedModel 漂移 → 缺 usage → usage 非法 → 按价格依据核定。
 * null 永远表示「未核定」，绝不落成 0；只有 free-evidence 且 usage 合法才允许 0。
 */
export function assessWindowCost(window: WindowRow, usage: Usage | null, servedModel: string | null): WindowCostAssessment {
  const unassessed = (status: WindowCostAssessment["status"], drift = false): WindowCostAssessment => ({
    cost: null, status, routeDrift: drift,
    amortized: window.amortized_nano_usd ?? null, marginal: window.marginal_nano_usd ?? null,
  });
  if (servedModel === null || servedModel !== window.served_model) return unassessed("route-drift", true);
  if (!usageValid(usage)) return usage === null ? unassessed("usage-missing") : unassessed("invalid-usage");
  if (window.price_basis === "free-evidence") return { cost: 0, status: "free-evidence", routeDrift: false, amortized: null, marginal: null };
  if (window.price_basis === "per-token") {
    const cost = actualCost(windowTariff(window), usage, servedModel);
    return cost === null ? unassessed("invalid-usage") : { cost, status: "assessed", routeDrift: false, amortized: null, marginal: null };
  }
  if (window.price_basis === "subscription-amortized") return unassessed("unassessed");
  return unassessed("unknown");
}
