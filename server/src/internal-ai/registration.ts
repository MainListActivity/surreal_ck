import { RecordId } from "surrealdb";
import { createHash } from "node:crypto";
import {
  COMPANY_PROOF_PROJECT, REVIEWED_DOCUMENT_MAX_BYTES, reviewedEvidenceSchema,
  type CompanyProofClaims, type CompanyProofGap, type ReviewedEvidence,
} from "@surreal-ck/shared";
import { HttpError } from "../http-error";
import { GOAL, hash, type Queryable } from "./store";
import { certificateFor, endpointHost, worstCost, type Tariff } from "./pricing";
import { CompanyStatusClient, type CompanyStatus } from "./company-status";
import { statusCapabilityHash } from "./company-proof";

/** 脱敏快照：只含授权/证据/上限，绝不含 subject、密钥或客户正文。 */
export type ActivitySnapshot = {
  enabled: boolean; goal: string; totalLimit: number; perAttemptLimit: number; attemptLimit: number;
  reserved: number; spent: number; attempts: number; approvalRevision: string | null;
  evidenceExpiresAt: string | null; priceRevisions: string[]; balanceNanoUsd: number | null;
  balanceCurrency: string | null; balanceSource: string | null; balanceSampledAt: string | null;
  balanceEvidenceHash: string | null; autoTopupDisabled: boolean; serviceApproved: boolean;
  evidenceKind: string | null; planName: string | null; planSourceUrl: string | null;
  quotaUnit: string | null; quotaAmount: number | null; quotaWindowSeconds: number | null;
  quotaRemaining: number | null; noPaymentInstrument: boolean | null;
};

/** 数据库行形状（snake_case，与 035/036 schema 列名一致）。 */
export type RevisionRow = {
  activity: string; revision: number; state: "disabled" | "enabled" | "revoked"; proof_type: string;
  goal: string; project: string; env: string; operator: string; reason: string; request_task: string;
  proof_expires_at: number; proof_jti: string | null; manifest_hash: string; document_hash: string; configuration_digest: string;
  identities_digest: string; approval_task: string | null; approval_version: number | null;
  approval_action: string | null; approval_audit_id: string | null; account_ref: string; endpoint: string;
  model: string; price_revision: string; currency: string | null; balance_nano_usd: number | null;
  balance_sampled_at: string | null; balance_source: string | null; evidence_expires_at: string | null; auto_topup_disabled: boolean;
  service_approved: boolean; status_capability_hash: string | null; gaps: string[];
  evidence_kind: "development-disabled" | "reviewed-service" | "reviewed-token-plan" | null;
  plan_name: string | null; plan_source_url: string | null; quota_unit: "points" | "requests" | null;
  quota_amount: number | null; quota_window_seconds: number | null; quota_remaining: number | null;
  no_payment_instrument: boolean | null;
  before: ActivitySnapshot | null; after: ActivitySnapshot | null; created_at?: unknown;
  source_jti: string | null;
};

export type IdentityRow = {
  identity_hash: string; activity: string; revision: number; alias: "LCA04_REMOVABLE" | "LCA04_MEMBER";
  space_id: string; database: string; workspace_role: "admin" | "participant"; billing_role: "owner" | "member";
  billing_account_ref: string; revoked: boolean;
};

export type RegistrationSummary = {
  activity: string; revision: number; currentRevision: number; currentEnabled: boolean; state: "disabled" | "enabled" | "revoked"; proofType: string;
  configurationDigest: string; documentHash: string; manifestHash: string; accountRef: string;
  endpoint: string; endpointHost: string | null; model: string; priceRevision: string; currency: string | null;
  balanceNanoUsd: number | null; balanceSource: string | null; sampledAt: string | null; expiresAt: string | null;
  evidenceKind: "development-disabled" | "reviewed-service" | "reviewed-token-plan" | null;
  planName: string | null; planSourceUrl: string | null; quotaUnit: "points" | "requests" | null;
  quotaAmount: number | null; quotaWindowSeconds: number | null; quotaRemaining: number | null;
  noPaymentInstrument: boolean | null;
  autoTopupDisabled: boolean; serviceApproved: boolean; paidCallsAllowed: 0 | 1;
  limits: { totalNanoUsd: number; perAttemptNanoUsd: number; maxAttempts: number };
  approval: { taskId: string; version: number; action: string; auditId: string } | null;
  requestTask: string; proofJti: string; operator: string; reason: string; dataReady: boolean;
  priceStatus: "unsupported" | "supported"; requiredEvidence: readonly string[]; gaps: string[];
  identities: Array<{ alias: string; identityHash: string; spaceId: string; database: string; workspaceRole: string; billingRole: string; billingAccountRef: string; revoked: boolean }>;
  before: ActivitySnapshot | null; after: ActivitySnapshot | null; idempotentReplay: boolean;
};

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const denied = (message: string) => new HttpError(422, "internal-ai-enable-denied", message);
const ACTIVITY_ID = /^[A-Za-z0-9_-]{1,100}$/;
export function normalizeReason(reason: unknown): string {
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 500 || [...reason].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) == 127)) {
    throw new HttpError(422, "internal-ai-reason-invalid", "操作原因必须为非空且无控制字符的短文本");
  }
  return reason.trim();
}
function compact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined));
}
function rows<T>(result: unknown): T[] {
  const first: unknown = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first as T[] : first && typeof first === "object" ? [first as T] : [];
}
export const PRICE_REQUIRED_EVIDENCE = ["provider", "host", "path", "model", "currency", "inputNanoUsdPerToken", "cachedInputNanoUsdPerToken", "outputNanoUsdPerToken", "maxInputTokens", "maxOutputTokens", "cacheBillingRelation", "reasoningBillingRelation", "worstCaseNanoUsd", "certificateSource", "certificateSampledAt", "certificateExpiresAt"] as const;
const SNAPSHOT = `SELECT enabled, goal, total_limit AS totalLimit, per_attempt_limit AS perAttemptLimit,
  attempt_limit AS attemptLimit, reserved, spent, attempts, approval_revision AS approvalRevision,
  evidence_expires_at AS evidenceExpiresAt, price_revisions AS priceRevisions, balance_nano_usd AS balanceNanoUsd,
  balance_currency AS balanceCurrency, balance_source AS balanceSource, balance_sampled_at AS balanceSampledAt,
  balance_evidence_hash AS balanceEvidenceHash, auto_topup_disabled AS autoTopupDisabled, service_approved AS serviceApproved,
  evidence_kind AS evidenceKind, plan_name AS planName, plan_source_url AS planSourceUrl,
  quota_unit AS quotaUnit, quota_amount AS quotaAmount, quota_window_seconds AS quotaWindowSeconds,
  quota_remaining AS quotaRemaining, no_payment_instrument AS noPaymentInstrument FROM ONLY $activity`;

export class InternalAiRegistration {
  constructor(private readonly db: () => Promise<Queryable>, private readonly status: CompanyStatus = new CompanyStatusClient(undefined)) {}
  async revisions(activity: string): Promise<RevisionRow[]> {
    return rows<RevisionRow>(await (await this.db()).query("SELECT * FROM internal_ai_revision WHERE activity = $activity ORDER BY revision", { activity }));
  }
  async revision(activity: string, revision: number): Promise<RevisionRow | undefined> {
    return rows<RevisionRow>(await (await this.db()).query("SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_revision", `${activity}:${revision}`) }))[0];
  }
  async identities(activity: string): Promise<IdentityRow[]> {
    return rows<IdentityRow>(await (await this.db()).query("SELECT * FROM internal_ai_identity WHERE activity = $activity ORDER BY alias", { activity }));
  }
  private id(activity: string): void {
    if (!ACTIVITY_ID.test(activity)) throw new HttpError(422, "internal-ai-id-invalid", "活动标识无效");
  }
  /** 提交前读路径的存储故障收成 503；消息只带错误类型名，绝不夹带 SQL、证明、bearer 或 subject。 */
  private async preflight<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const name = e instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : "Error";
      throw new HttpError(503, "company-proof-store-unavailable", `公司证明存储不可用（${name}）`);
    }
  }
  private async latest(activity: string): Promise<RevisionRow | undefined> { return (await this.revisions(activity)).at(-1); }
  private async fresh(activity: string, revision: number): Promise<RevisionRow> {
    this.id(activity);
    const latest = await this.latest(activity);
    if (!latest) throw new HttpError(404, "internal-ai-revision-missing", "登记版本不存在");
    if (latest.revision !== revision) throw conflict("internal-ai-stale-revision", "登记版本已变更，禁止使用旧证据启用");
    return latest;
  }
  /** 状态与root账本分离；每次attempt重新请求签名状态，不缓存60秒的撤回窗口。 */
  async assertCurrent(activity: string): Promise<void> {
    const latest = await this.latest(activity);
    if (!latest || latest.state !== "enabled") throw denied("内部活动已禁用");
    await this.status.current(activity, latest.source_jti ?? latest.proof_jti ?? "");
  }
  /** 活动、身份、前后快照和审计一次提交。CAS版本和写冲突阻止并发部分更新。 */
  private async mutate(row: RevisionRow, expected: number, sql: string, vars: Record<string, unknown> = {}): Promise<RevisionRow> {
    const values = compact({ ...row, before: undefined, after: undefined, created_at: undefined, id: undefined });
    const content = Object.keys(values).map(k => `${k}: $row.${k}`).join(", ");
    const rid = new RecordId("internal_ai_revision", `${row.activity}:${row.revision}`);
    try {
      await (await this.db()).query(`BEGIN TRANSACTION;
        LET $latest = (SELECT revision FROM internal_ai_revision WHERE activity = $name ORDER BY revision DESC LIMIT 1)[0];
        IF ($latest.revision ?? 0) != $expected { THROW "registration-conflict"; };
        LET $before = (${SNAPSHOT});
        ${sql}
        LET $after = (${SNAPSHOT});
        CREATE ONLY $revision CONTENT { ${content}, before: $before, after: $after };
        COMMIT TRANSACTION;`, { ...vars, row: values, expected, name: row.activity, activity: new RecordId("internal_ai_activity", row.activity), revision: rid });
    } catch { throw conflict("internal-ai-registration-conflict", "登记事务未确认或并发冲突；请读回后重试"); }
    const saved = await this.revision(row.activity, row.revision);
    if (!saved) throw conflict("internal-ai-registration-conflict", "登记审计未确认");
    return saved;
  }
  async register(input: { claims: CompanyProofClaims; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason), c = input.claims, m = c.manifest, activity = m.activityId;
    this.id(activity);
    const [owner, member] = c.identities;
    if (owner.alias !== "LCA04_REMOVABLE" || owner.workspaceRole !== "admin" || owner.billingRole !== "owner"
      || member.alias !== "LCA04_MEMBER" || member.workspaceRole !== "participant" || member.billingRole !== "member"
      || owner.subject === member.subject || owner.database !== member.database || owner.spaceId !== member.spaceId || owner.billingAccountRef !== member.billingAccountRef) {
      throw denied("身份角色或 workspace/计费账户不匹配");
    }
    await this.status.check(c);
    const prior = await this.preflight(async () => rows<RevisionRow>(await (await this.db()).query("SELECT * FROM internal_ai_revision WHERE proof_jti = $jti LIMIT 1", { jti: c.jti }))[0]);
    const manifestHash = createHash("sha256").update(canonical(m)).digest("hex");
    if (prior) {
      if (prior.activity !== activity || prior.configuration_digest !== c.configurationDigest || prior.document_hash !== c.documentHash
        || prior.identities_digest !== c.identitiesDigest || prior.manifest_hash !== manifestHash || prior.proof_type !== c.type
        || prior.request_task !== c.requestTask || prior.proof_expires_at !== c.exp
        || (prior.approval_task ?? null) !== (c.approval?.taskId ?? null) || (prior.approval_version ?? null) !== (c.approval?.version ?? null)
        || (prior.approval_action ?? null) !== (c.approval?.action ?? null) || (prior.approval_audit_id ?? null) !== (c.approval?.auditId ?? null)) {
        throw conflict("company-proof-revision-conflict", "同一证明标识已登记不同证据");
      }
      this.status.remember(activity, c);
      return this.preflight(() => this.summary(prior, true));
    }
    const latest = await this.preflight(() => this.latest(activity));
    if (latest && latest.configuration_digest !== c.configurationDigest) throw conflict("company-proof-activity-conflict", "同活动已登记不同配置摘要");
    const bindings: IdentityRow[] = c.identities.map(i => ({ identity_hash: hash(i.subject, i.database), activity, revision: (latest?.revision ?? 0) + 1,
      alias: i.alias, space_id: i.spaceId, database: i.database, workspace_role: i.workspaceRole,
      billing_role: i.billingRole, billing_account_ref: i.billingAccountRef, revoked: false }));
    const current = await this.preflight(() => this.identities(activity));
    if (current.length && (current.length !== 2 || current.some(i => !bindings.some(b => b.identity_hash === i.identity_hash && b.alias === i.alias)))) {
      throw conflict("internal-ai-identity-bound", "同活动身份改绑冲突");
    }
    const row: RevisionRow = { activity, revision: (latest?.revision ?? 0) + 1, state: "disabled", proof_type: c.type,
      goal: GOAL, project: COMPANY_PROOF_PROJECT, env: "production", operator: input.operator, reason,
      request_task: c.requestTask, proof_jti: c.jti, source_jti: c.jti, proof_expires_at: c.exp,
      manifest_hash: manifestHash, document_hash: c.documentHash, configuration_digest: c.configurationDigest, identities_digest: c.identitiesDigest,
      approval_task: c.approval?.taskId ?? null, approval_version: c.approval?.version ?? null, approval_action: c.approval?.action ?? null,
      approval_audit_id: c.approval?.auditId ?? null, account_ref: m.service.accountRef, endpoint: m.service.endpoint, model: m.service.model,
      price_revision: m.service.priceRevision, currency: null, balance_nano_usd: null, balance_sampled_at: null, balance_source: null, evidence_expires_at: null,
      evidence_kind: null, plan_name: null, plan_source_url: null, quota_unit: null, quota_amount: null,
      quota_window_seconds: null, quota_remaining: null, no_payment_instrument: null,
      auto_topup_disabled: true, service_approved: false, status_capability_hash: statusCapabilityHash(c.status.bearer),
      gaps: ["approved-service-evidence", "balance-evidence", "price-certificate"], before: null, after: null };
    const sql = `FOR $b IN $bindings {
      LET $bound = (SELECT * FROM internal_ai_binding WHERE identity_hash = $b.identity_hash LIMIT 1)[0];
      IF $bound != NONE AND $bound.activity != $name { THROW "identity-bound"; };
      IF $bound.revoked = true { THROW "identity-revoked"; };
    };
    INSERT INTO internal_ai_activity $config ON DUPLICATE KEY UPDATE enabled = false;
    UPDATE ONLY $activity SET enabled = false, registration_jti = $row.source_jti, proof_expires_at = $row.proof_expires_at;
    FOR $b IN $bindings {
      INSERT INTO internal_ai_identity $b ON DUPLICATE KEY UPDATE revision = $input.revision;
      INSERT INTO internal_ai_binding $b ON DUPLICATE KEY UPDATE revision = $input.revision;
    };`;
    const saved = await this.mutate(row, latest?.revision ?? 0, sql, { bindings, config: {
      id: new RecordId("internal_ai_activity", activity), goal: GOAL, enabled: false, total_limit: m.budget.totalNanoUsd,
      per_attempt_limit: m.budget.perAttemptNanoUsd, attempt_limit: m.budget.maxAttempts, price_revisions: [], auto_topup_disabled: true, service_approved: false,
    } });
    this.status.remember(activity, c);
    return this.summary(saved, false);
  }
  async submitEvidence(input: { activity: string; revision: number; document: string; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason), target = await this.fresh(input.activity, input.revision);
    const bytes = Buffer.from(input.document, "utf8");
    if (!bytes.length || bytes.length > REVIEWED_DOCUMENT_MAX_BYTES) throw denied("证据文档大小超出边界");
    const documentHash = createHash("sha256").update(bytes).digest("hex");
    if (documentHash !== target.document_hash) throw conflict("company-proof-evidence-mismatch", "证据文档与公司证明签发的文档摘要不一致");
    let json: unknown;
    try { json = JSON.parse(input.document); } catch { throw denied("证据文档不是合法 JSON"); }
    const parsed = reviewedEvidenceSchema.safeParse(json);
    if (!parsed.success) throw denied("证据文档字段不合法或不符合受审证据契约");
    const e: ReviewedEvidence = parsed.data;
    if (e.accountRef !== target.account_ref || e.endpoint !== target.endpoint || e.model !== target.model || e.priceRevision !== target.price_revision
      || (target.proof_type === "approved-service" && e.type !== "reviewed-service" && e.type !== "reviewed-token-plan")) throw denied("证据文档服务标识或类型不一致");
    await this.status.current(input.activity, target.source_jti ?? target.proof_jti ?? "");
    // 配额型证据：USD 余额字段必须为空，绝不允许把配额换算成美元；余额型证据则清空全部配额字段。
    const tokenPlan = e.type === "reviewed-token-plan";
    const row: RevisionRow = { ...target, revision: target.revision + 1, state: "disabled", operator: input.operator, reason,
      proof_jti: null, evidence_kind: e.type, currency: tokenPlan ? null : "USD",
      balance_nano_usd: tokenPlan ? null : e.balanceNanoUsd, balance_sampled_at: e.sampledAt, evidence_expires_at: e.expiresAt,
      balance_source: `${tokenPlan ? "token-plan" : "reviewed-document"}:${documentHash}`,
      plan_name: tokenPlan ? e.planName : null, plan_source_url: tokenPlan ? e.planSourceUrl : null,
      quota_unit: tokenPlan ? e.quotaUnit : null, quota_amount: tokenPlan ? e.quotaAmount : null,
      quota_window_seconds: tokenPlan ? e.quotaWindowSeconds : null, quota_remaining: tokenPlan ? e.quotaRemaining : null,
      no_payment_instrument: tokenPlan ? e.noPaymentInstrument : null,
      auto_topup_disabled: e.autoTopupDisabled, service_approved: e.serviceApproved, before: null, after: null };
    row.gaps = this.evidenceGaps(row);
    return this.summary(await this.mutate(row, target.revision, "UPDATE ONLY $activity SET enabled = false;"), false);
  }
  private evidenceGaps(r: RevisionRow): CompanyProofGap[] {
    const gaps: CompanyProofGap[] = [];
    if (r.proof_type !== "approved-service" || !r.approval_task || !r.approval_version) gaps.push("approved-service-evidence");
    if (r.evidence_kind === "reviewed-token-plan") {
      // 配额型证据：USD 余额三项检查整体替换为配额检查；两族缺口语义不互换。
      if (!r.plan_name || !r.plan_source_url || !r.quota_unit || r.quota_amount == null || r.quota_window_seconds == null) gaps.push("quota-evidence");
      else if (r.quota_amount <= 0 || (r.quota_remaining != null && r.quota_remaining <= 0)) gaps.push("quota-positive");
      if (r.no_payment_instrument !== true) gaps.push("payment-instrument-absent");
    } else {
      if (r.balance_nano_usd == null) gaps.push("balance-evidence");
      else if (r.balance_nano_usd <= 0) gaps.push("balance-positive");
      if (r.currency !== "USD") gaps.push("balance-currency");
    }
    const sampled = Date.parse(r.balance_sampled_at ?? ""), expires = Date.parse(r.evidence_expires_at ?? "");
    if (!Number.isFinite(sampled) || sampled > Date.now()) gaps.push("balance-sampled-at");
    // 最大24小时资料窗口；未知、无限期或过期均不能获得现金许可。
    if (!Number.isFinite(expires) || expires <= Date.now() || expires <= sampled || expires - sampled > 86400000 || r.proof_expires_at * 1000 <= Date.now()) gaps.push("evidence-not-expired");
    if (!r.auto_topup_disabled) gaps.push("auto-topup-disabled");
    if (!r.service_approved) gaps.push("service-approved");
    return gaps;
  }
  async gapsFor(r: RevisionRow, runtime: { provider?: string; model?: string; endpoint?: string; jevModel?: string; jevEnabled?: boolean }): Promise<CompanyProofGap[]> {
    const gaps = this.evidenceGaps(r), cert = certificateFor(r.endpoint, r.model);
    if (r.state !== "disabled") gaps.push("approved-service-evidence");
    if (!cert || cert.revision !== r.price_revision || cert.provider !== runtime.provider || runtime.model !== r.model || runtime.endpoint !== r.endpoint) gaps.push("price-certificate");
    // 公司契约只有单服务余额/证书；Jev没有自己的受审账户资料时拒绝启用含Jev的活动。
    if (runtime.jevEnabled) gaps.push("price-certificate");
    const ids = await this.identities(r.activity);
    if (ids.length !== 2 || !ids.some(i => i.alias === "LCA04_REMOVABLE") || !ids.some(i => i.alias === "LCA04_MEMBER")) gaps.push("identity-binding");
    if (ids.some(i => i.revoked)) gaps.push("identity-revoked");
    return [...new Set(gaps)];
  }
  async enable(input: { activity: string; revision: number; operator: string; reason: string; runtime: { provider?: string; model?: string; endpoint?: string; jevModel?: string; jevEnabled?: boolean } }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason), target = await this.fresh(input.activity, input.revision);
    const gaps = await this.gapsFor(target, input.runtime);
    if (gaps.length) throw denied(`启用证据不足：${gaps.join(", ")}`);
    const cert = certificateFor(target.endpoint, target.model) as Tariff;
    await this.status.current(input.activity, target.source_jti ?? target.proof_jti ?? "");
    const row: RevisionRow = { ...target, revision: target.revision + 1, state: "enabled", operator: input.operator, reason, proof_jti: null, gaps: [], before: null, after: null };
    // 配额型证据没有 USD 余额：跳过余额覆盖上限，配额资料与余额资料互斥写入（NONE 清除另一种类的陈旧字段）。
    const sql = `LET $a = (SELECT * FROM ONLY $activity);
      IF $a.registration_jti != $row.source_jti OR $a.goal != $row.goal OR $a.total_limit <= 0 OR $a.total_limit > 1000000000 OR ($row.evidence_kind != "reviewed-token-plan" AND $a.total_limit > $row.balance_nano_usd) OR $a.per_attempt_limit < $worst OR $a.per_attempt_limit > 100000000 OR $a.attempt_limit <= 0 OR $a.attempt_limit > 30 { THROW "budget-bounds"; };
      IF array::len(SELECT * FROM internal_ai_identity WHERE activity = $name AND revoked = false) != 2 { THROW "identity-revoked"; };
      IF <datetime>$row.evidence_expires_at <= time::now() OR $row.proof_expires_at <= time::unix() { THROW "proof-expired"; };
      UPDATE ONLY $activity SET enabled = true, approval_revision = $approval, evidence_expires_at = $row.evidence_expires_at,
        price_revisions = [$row.price_revision], evidence_kind = $row.evidence_kind,
        balance_nano_usd = $row.balance_nano_usd, balance_currency = $row.currency,
        balance_source = $source, balance_sampled_at = $row.balance_sampled_at, balance_evidence_hash = $row.document_hash,
        plan_name = $row.plan_name, plan_source_url = $row.plan_source_url, quota_unit = $row.quota_unit,
        quota_amount = $row.quota_amount, quota_window_seconds = $row.quota_window_seconds,
        quota_remaining = $row.quota_remaining, no_payment_instrument = $row.no_payment_instrument,
        auto_topup_disabled = true, service_approved = true;`;
    return this.summary(await this.mutate(row, target.revision, sql, { worst: worstCost(cert), approval: `${target.approval_task}@${target.approval_version}`, source: `${target.evidence_kind === "reviewed-token-plan" ? "token-plan" : "reviewed-document"}:${target.document_hash}` }), false);
  }
  async disable(input: { activity: string; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason); this.id(input.activity);
    const target = await this.latest(input.activity);
    if (!target) throw new HttpError(404, "internal-ai-unconfigured", "内部活动尚未受审配置");
    const row: RevisionRow = { ...target, revision: target.revision + 1, state: "disabled", operator: input.operator, reason, proof_jti: null, before: null, after: null };
    return this.summary(await this.mutate(row, target.revision, "UPDATE ONLY $activity SET enabled = false;"), false);
  }
  async revokeIdentity(input: { alias: "LCA04_REMOVABLE" | "LCA04_MEMBER"; activity: string; operator: string; reason: string }): Promise<{ alias: string; identityHash: string; activity: string; revoked: true }> {
    const reason = normalizeReason(input.reason); this.id(input.activity);
    const target = await this.latest(input.activity), bound = (await this.identities(input.activity)).find(i => i.alias === input.alias);
    if (!target || !bound) throw new HttpError(404, "internal-ai-identity-missing", "尚未登记该别名身份");
    if (bound.revoked) return { alias: input.alias, identityHash: bound.identity_hash, activity: input.activity, revoked: true };
    const row: RevisionRow = { ...target, revision: target.revision + 1, state: "revoked", operator: input.operator, reason, proof_jti: null, gaps: ["identity-revoked"], before: null, after: null };
    await this.mutate(row, target.revision, `UPDATE internal_ai_identity SET revoked = true, revoked_at = time::now(), revoke_reason = $reason WHERE identity_hash = $identity;
      UPDATE internal_ai_binding SET revoked = true, revoked_at = time::now(), revoke_reason = $reason WHERE identity_hash = $identity;
      UPDATE ONLY $activity SET enabled = false;`, { reason, identity: bound.identity_hash });
    return { alias: input.alias, identityHash: bound.identity_hash, activity: input.activity, revoked: true };
  }
  async preview(activity: string): Promise<RegistrationSummary[]> { return Promise.all((await this.revisions(activity)).map(r => this.summary(r, false))); }
  private async summary(row: RevisionRow, idempotentReplay: boolean): Promise<RegistrationSummary> {
    const ids = await this.identities(row.activity), cert = certificateFor(row.endpoint, row.model);
    const latest = await this.latest(row.activity);
    let ready = latest?.revision === row.revision && row.state === "enabled" && this.evidenceGaps(row).length === 0 && Boolean(cert) && !ids.some(i => i.revoked);
    if (ready) { try { await this.status.current(row.activity, row.source_jti ?? row.proof_jti ?? ""); } catch { ready = false; } }
    const a = rows<{ total_limit: number; per_attempt_limit: number; attempt_limit: number }>(await (await this.db()).query("SELECT total_limit, per_attempt_limit, attempt_limit FROM ONLY $id", { id: new RecordId("internal_ai_activity", row.activity) }))[0];
    return { activity: row.activity, revision: row.revision, currentRevision: latest?.revision ?? 0, currentEnabled: latest?.state === "enabled", state: row.state, proofType: row.proof_type,
      configurationDigest: row.configuration_digest, documentHash: row.document_hash, manifestHash: row.manifest_hash,
      accountRef: row.account_ref, endpoint: row.endpoint, endpointHost: endpointHost(row.endpoint), model: row.model, priceRevision: row.price_revision,
      currency: row.currency ?? null, balanceNanoUsd: row.balance_nano_usd ?? null, balanceSource: row.balance_source ?? null,
      sampledAt: row.balance_sampled_at ?? null, expiresAt: row.evidence_expires_at ?? null,
      evidenceKind: row.evidence_kind ?? null,
      planName: row.plan_name ?? null, planSourceUrl: row.plan_source_url ?? null, quotaUnit: row.quota_unit ?? null,
      quotaAmount: row.quota_amount ?? null, quotaWindowSeconds: row.quota_window_seconds ?? null,
      quotaRemaining: row.quota_remaining ?? null, noPaymentInstrument: row.no_payment_instrument ?? null,
      autoTopupDisabled: row.auto_topup_disabled, serviceApproved: row.service_approved, paidCallsAllowed: ready ? 1 : 0,
      limits: { totalNanoUsd: a?.total_limit ?? 0, perAttemptNanoUsd: a?.per_attempt_limit ?? 0, maxAttempts: a?.attempt_limit ?? 0 },
      approval: row.approval_task && row.approval_version && row.approval_action && row.approval_audit_id ? { taskId: row.approval_task, version: row.approval_version, action: row.approval_action, auditId: row.approval_audit_id } : null,
      requestTask: row.request_task, proofJti: row.source_jti ?? row.proof_jti ?? "", operator: row.operator, reason: row.reason,
      dataReady: ready,
      priceStatus: cert ? "supported" : "unsupported", requiredEvidence: PRICE_REQUIRED_EVIDENCE, gaps: row.gaps,
      identities: ids.map(i => ({ alias: i.alias, identityHash: i.identity_hash, spaceId: i.space_id, database: i.database,
        workspaceRole: i.workspace_role, billingRole: i.billing_role, billingAccountRef: i.billing_account_ref, revoked: i.revoked })),
      before: row.before ?? null, after: row.after ?? null, idempotentReplay };
  }
}
/** 与公司规范JSON字节规则一致；不引用运营仓库代码。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
