import { createHash } from "node:crypto";
import {
  MAGPIE_CAPACITY_SCOPE, MAGPIE_WINDOW_LEGACY_PREFIXES, MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS,
  type MagpieWindowCreate, type MagpieWindowPriceBasis,
} from "@surreal-ck/shared";
import { actualCost, tariffFor, TARIFFS, worstCost, type Tariff, type Usage } from "./pricing";
import type { RecordId } from "surrealdb";

/** 窗口行的数据库形状（snake_case，与 039 schema 一致）。 */
export type WindowRow = {
  id: RecordId; activity: string; approval_digest: string; approval_task: string; account_ref: string;
  evidence_expires_at: string; attempt_limit: number; source_budget_nano_usd: number; per_attempt_nano_usd: number;
  attempts: number; reserved: number; spent: number; status: string; revision: number;
  route_revision: string; route_digest: string; requested_model: string; served_model: string;
  endpoint: string; account_binding: string; price_revision: string; price_basis: MagpieWindowPriceBasis;
  free_evidence_hash: string | null; amortized_nano_usd: number | null; marginal_nano_usd: number | null;
  max_output_tokens: number; sampled_at: string; route_expires_at: string;
  capacity_database: string; capacity_tables: number; capacity_fields: number; capacity_records: number;
  capacity_ttl_seconds: number; capacity_destructive: boolean; capacity_source: string;
  idempotency_key: string; payload_hash: string; operator: string; reason: string;
  created_at: unknown; bound_at: unknown;
};

/** 带稳定错误码的拒绝：路由层映射为 4xx，调用方不解析自由文本。 */
export class WindowDenied extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WindowDenied"; }
}
const deny = (code: string, message: string): never => { throw new WindowDenied(code, message); };

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
 * 创建窗口的全部拒绝条件。`totalUsed` = 全部历史 attempt 数（含 failed/uncertain），
 * `committedAttempts` = 现有 active 窗口 attempt_limit 之和；两者共同保证不重领 30。
 */
export function validateWindowCreate(input: MagpieWindowCreate, ctx: { totalUsed: number; committedAttempts: number; activityTotalLimit: number; activityPerAttemptLimit: number }): void {
  const hit = legacyHit(input.approvalDigest, input.approvalTask, input.accountRef);
  if (hit) deny("magpie-window-legacy-rejected", `输入命中旧周期/旧批准/旧 proof 前缀 ${hit}`);
  const expires = parseInstant(input.evidenceExpiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) deny("magpie-window-evidence-expired", "证据期必须晚于当前时间");
  if (input.sourceBudgetNanoUsd > ctx.activityTotalLimit) deny("magpie-window-cap-inheritance", "源预算 USD 不得超过既有活动总上限");
  if (input.perAttemptNanoUsd > ctx.activityPerAttemptLimit) deny("magpie-window-cap-inheritance", "单次预算 USD 不得超过既有活动单次上限");
  const remaining = MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS - ctx.totalUsed - ctx.committedAttempts;
  if (remaining <= 0 || input.sourceBudgetAttempts > remaining) deny("magpie-window-remaining-insufficient", `剩余可用次数不足：请求 ${input.sourceBudgetAttempts}，可用 ${Math.max(0, remaining)}`);
  validateCapacity(input.capacity);
  validateRoute(input);
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

/** 运行时路由必须与窗口冻结快照一致；host/port/path/scheme 任一不同即漂移。 */
export function routeMatches(window: WindowRow, provider: string, model: string, endpoint: string): boolean {
  if (provider !== "openai" || model !== window.requested_model) return false;
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
