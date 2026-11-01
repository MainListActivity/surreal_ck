import { createHash } from "node:crypto";
import {
  MAGPIE_B_ENVELOPE, MAGPIE_FREE_BASIS_VERSION, MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION, magpieFreeQuotaBasisSchema,
  type MagpieFreeQuotaBasis, type MagpieFreeQuotaRemoteWindowCreate, type MagpieFreeStopReason,
} from "@surreal-ck/shared";
import { assertRemoteEvidence, canonicalJson, WindowDenied, type RemoteWindowContext, type WindowCostAssessment, type WindowCreateRequest, type WindowRow } from "./window";

const deny: (code: string, message: string) => never = (code, message) => { throw new WindowDenied(code, message); };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** v3 窗口行（contract_version 为 magpie-window/v3）；v1/v2 行与 NONE 旧行都不是免费依据窗口。 */
export const isFreeQuotaWindow = (row: { contract_version?: string | null }): boolean => row.contract_version === MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION;

/** 依据的规范化内容：canonical JSON（键排序、无空白），同一依据跨进程得到同一字节串。 */
export function freeQuotaBasisContent(basis: MagpieFreeQuotaBasis): string { return canonicalJson(basis); }

/** 依据记录 id = 规范化内容的 sha256；服务端可由 content 复算，客户端不得自填。 */
export function freeQuotaBasisHash(basis: MagpieFreeQuotaBasis): string { return sha256(freeQuotaBasisContent(basis)); }

/**
 * 读回并复算依据记录：content 的 sha256 必须等于记录 id，且内容必须通过依据 schema、
 * 并已是规范形式。任一不满足返回 null，调用方一律按 invalid 处理，绝不信任其它列值。
 */
export function readFreeQuotaBasis(content: string, hash: string): MagpieFreeQuotaBasis | null {
  if (sha256(content) !== hash) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  const result = magpieFreeQuotaBasisSchema.safeParse(parsed);
  if (!result.success || canonicalJson(result.data) !== content) return null;
  return result.data;
}

/**
 * 依据端点严格核对：端点必须逐字等于 https://<依据主机><依据路径>，仅允许末尾一个斜杠。
 * 不做 URL 规范化：显式 :443、大写主机、凭据、查询、片段、点段、首尾空白与 http 一律不符。
 */
export function basisEndpointMatches(basis: MagpieFreeQuotaBasis, endpoint: string): boolean {
  const base = `https://${basis.route.host}${basis.route.path}`;
  return endpoint === base || endpoint === `${base}/`;
}

/**
 * 依据适用路由复核：端点严格符合依据（见 basisEndpointMatches），served model 必须一致。
 * 路由不符返回 route-drift，served model 不符返回 served-model-drift。
 */
export function basisRouteStop(basis: MagpieFreeQuotaBasis, endpoint: string, servedModel: string): "route-drift" | "served-model-drift" | null {
  if (!basisEndpointMatches(basis, endpoint)) return "route-drift";
  return servedModel === basis.route.servedModel ? null : "served-model-drift";
}

/**
 * 请求前（begin）的依据门禁：依据缺失或不可复算 → free-basis-invalid；到期（含到期瞬间）→ free-basis-expired；
 * 窗口冻结的路由与 served model 必须仍与依据一致。返回停止原因，null 表示可继续。
 */
export function freeQuotaBeginStop(basis: MagpieFreeQuotaBasis | null, window: WindowRow, now: number): MagpieFreeStopReason | null {
  if (!basis || window.envelope !== MAGPIE_B_ENVELOPE.id || window.free_evidence_hash !== freeQuotaBasisHash(basis)) return "free-basis-invalid";
  if (now < Date.parse(basis.effectiveAt)) return "free-basis-invalid";
  if (now >= Date.parse(basis.expiresAt)) return "free-basis-expired";
  return basisRouteStop(basis, window.endpoint, window.served_model);
}

/**
 * 请求端点门禁（每次发送前）：本次实际请求端点必须仍严格符合依据路由；不符即 route-drift，本次不发送。
 * 与窗口冻结端点的同源核对由 routeMatches 承担（host/path/端口 key 必须一致）。
 */
export function freeQuotaRequestStop(basis: MagpieFreeQuotaBasis | null, endpoint: string): MagpieFreeStopReason | null {
  if (!basis) return "free-basis-invalid";
  return basisEndpointMatches(basis, endpoint) ? null : "route-drift";
}

/**
 * 请求后（finish）的停止判定：只有 free-evidence（served model 一致且 usage 合法）才继续；
 * served 漂移、缺 usage、非法 usage 一律停止；未知状态按 fail-closed 记为 provider-uncertain。
 */
export function freeQuotaFinishStop(status: WindowCostAssessment["status"]): MagpieFreeStopReason | null {
  switch (status) {
    case "free-evidence": return null;
    case "route-drift": return "served-model-drift";
    case "usage-missing": return "usage-missing";
    case "invalid-usage": return "usage-invalid";
    default: return "provider-uncertain";
  }
}

/** 远端失败分类（只决定停止原因标签，任何失败都停止 v3 窗口）：402 或计费关键字 → billing-required；额度用尽关键字 → quota-exhausted；其余 provider-uncertain。 */
const QUOTA_PATTERN = /insufficient[ _-]?quota|quota[ _-]?(?:exceeded|exhausted|depleted)|exceeded (?:your )?(?:current )?quota|out of (?:free )?quota|额度|配额|用尽/i;
const BILLING_PATTERN = /billing|payment[ _-]?required|insufficient[ _-]?(?:balance|funds|credits?)|subscription[ _-]?(?:required|expired|inactive)|arrear|overdue|欠费|余额不足|充值|付费|账单/i;

function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const value of [record.statusCode, record.status, record.response?.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

/** 收集错误中的文本（message、响应正文、解析后的 JSON 字段），有深度与长度上限；不落日志、不返回。 */
function failureText(error: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || parts.join("\n").length > 4000) return;
    if (typeof value === "string") { parts.push(value); return; }
    if (typeof value === "number" || typeof value === "boolean") { parts.push(String(value)); return; }
    if (value instanceof Error) parts.push(value.message);
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) visit(nested, depth + 1);
    }
  };
  visit(error, 0);
  return parts.join("\n").slice(0, 4000);
}

/**
 * 远端失败形状分类：仓库内尚无远端真实额度错误样例，规则保守；未知即 provider-uncertain。
 * 分类只决定停止原因标签，任何 v3 失败都停止窗口，不自动重试。
 */
export function classifyProviderFailure(error: unknown): MagpieFreeStopReason {
  if (statusCodeOf(error) === 402) return "billing-required";
  const text = failureText(error);
  if (QUOTA_PATTERN.test(text)) return "quota-exhausted";
  if (BILLING_PATTERN.test(text)) return "billing-required";
  return "provider-uncertain";
}

/** 零费率核对：原始单价必须是纯数字零（空串、非数字一律不算零）。 */
const isZeroPrice = (raw: string): boolean => /^0+(?:\.0+)?$/.test(raw.trim());

/** v3 远端窗口构建上下文：依据记录（null = 不存在或不可复算）；B 包络关闭状态由 validateWindowEnvelope 统一把关。 */
export type FreeQuotaWindowContext = RemoteWindowContext & { basis: MagpieFreeQuotaBasis | null };

/**
 * 远端免费窗口（v3）：证据门禁与 v2 同源（assertRemoteEvidence），再叠加依据门禁：
 * 依据必须存在且可复算；未到期，且窗口证据期不越过依据期限；路由 host/path/servedModel 与依据一致；
 * 目录必须同时标注免费且原始单价为零。价格只由依据派生（free-evidence），
 * 目录 0/0 与 reviewed 状态都不参与价格派生，TARIFFS 不被改写。
 */
export function buildFreeQuotaRemoteWindowRequest(input: MagpieFreeQuotaRemoteWindowCreate, ctx: FreeQuotaWindowContext): WindowCreateRequest {
  const runtime = assertRemoteEvidence(input, ctx);
  const evidence = input.evidence;
  const basis = ctx.basis;
  if (!basis) deny("magpie-window-free-basis-unknown", "免费额度依据记录不存在");
  const hash = freeQuotaBasisHash(basis);
  if (hash !== input.freeQuotaBasisHash) deny("magpie-window-free-basis-invalid", "免费额度依据 hash 与记录内容不一致");
  const now = ctx.now ?? Date.now();
  const basisExpiry = Date.parse(basis.expiresAt);
  if (now < Date.parse(basis.effectiveAt)) deny("magpie-window-free-basis-not-effective", "免费额度依据尚未生效");
  if (now >= basisExpiry || Date.parse(input.evidenceExpiresAt) > basisExpiry) deny("magpie-window-free-basis-expired", "免费额度依据已过期或窗口证据期超出依据期限");
  if (basisRouteStop(basis, runtime.endpoint, evidence.route.servedModel)) deny("magpie-window-free-basis-route-mismatch", "路由或 served model 与免费额度依据不符");
  // 证据来源端点同样必须严格符合依据：assertRemoteEvidence 只比较 host/path key，不排除查询串与端口等差异。
  if (!basisEndpointMatches(basis, evidence.source.endpoint)) deny("magpie-window-free-basis-route-mismatch", "证据来源端点与免费额度依据路由不符");
  if (!evidence.pricing.free || !isZeroPrice(evidence.pricing.rawPrompt) || !isZeroPrice(evidence.pricing.rawCompletion)) {
    deny("magpie-window-free-basis-conflict", "目录未标注免费或原始单价非零，与免费额度依据冲突");
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
      priceRevision: `${MAGPIE_FREE_BASIS_VERSION}:${hash}`, priceBasis: "free-evidence", freeEvidenceHash: hash,
      amortizedNanoUsd: null, marginalNanoUsd: null,
      maxOutputTokens: input.maxOutputTokens, sampledAt: evidence.route.sampledAt,
      expiresAt: evidence.route.expiresAt, provider: runtime.providerId,
    },
    capacity: input.capacity, idempotencyKey: input.idempotencyKey, reason: input.reason,
    contractVersion: MAGPIE_FREE_QUOTA_WINDOW_CONTRACT_VERSION,
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
