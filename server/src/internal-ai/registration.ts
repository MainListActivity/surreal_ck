import { RecordId } from "surrealdb";
import { createHash } from "node:crypto";
import {
  COMPANY_PROOF_PROJECT, REVIEWED_DOCUMENT_MAX_BYTES, reviewedEvidenceSchema,
  type CompanyProofClaims, type CompanyProofGap, type ReviewedEvidence,
} from "@surreal-ck/shared";
import { HttpError } from "../http-error";
import { GOAL, hash, type Queryable } from "./store";
import { certificateFor, endpointHost, worstCost, type Tariff } from "./pricing";
import { statusCapabilityHash } from "./company-proof";

/** 脱敏快照：只含授权/证据/上限，绝不含 subject、密钥或客户正文。 */
export type ActivitySnapshot = {
  enabled: boolean; goal: string; totalLimit: number; perAttemptLimit: number; attemptLimit: number;
  reserved: number; spent: number; attempts: number; approvalRevision: string | null;
  evidenceExpiresAt: string | null; priceRevisions: string[]; balanceNanoUsd: number | null;
  balanceCurrency: string | null; balanceSource: string | null; balanceSampledAt: string | null;
  balanceEvidenceHash: string | null; autoTopupDisabled: boolean; serviceApproved: boolean;
};

/** 数据库行形状（snake_case，与 035 schema 列名一致）。 */
export type RevisionRow = {
  activity: string; revision: number; state: "disabled" | "enabled" | "revoked"; proof_type: string;
  goal: string; project: string; env: string; operator: string; reason: string; request_task: string;
  proof_jti: string | null; manifest_hash: string; document_hash: string; configuration_digest: string;
  identities_digest: string; approval_task: string | null; approval_version: number | null;
  approval_action: string | null; approval_audit_id: string | null; account_ref: string; endpoint: string;
  model: string; price_revision: string; currency: string; balance_nano_usd: number | null;
  balance_sampled_at: string | null; evidence_expires_at: string | null; auto_topup_disabled: boolean;
  service_approved: boolean; status_capability_hash: string | null; gaps: string[];
  before: ActivitySnapshot | null; after: ActivitySnapshot | null; created_at?: unknown;
  source_jti: string | null;
};

export type IdentityRow = {
  identity_hash: string; activity: string; revision: number; alias: "LCA04_REMOVABLE" | "LCA04_MEMBER";
  space_id: string; database: string; workspace_role: "admin" | "participant"; billing_role: "owner" | "member";
  billing_account_ref: string; revoked: boolean;
};

export type RegistrationSummary = {
  activity: string; revision: number; state: "disabled" | "enabled" | "revoked"; proofType: string;
  configurationDigest: string; documentHash: string; manifestHash: string; accountRef: string;
  endpoint: string; endpointHost: string | null; model: string; priceRevision: string; currency: "USD";
  balanceNanoUsd: number | null; sampledAt: string | null; expiresAt: string | null;
  autoTopupDisabled: boolean; serviceApproved: boolean; paidCallsAllowed: 0;
  limits: { totalNanoUsd: number; perAttemptNanoUsd: number; maxAttempts: number };
  approval: { taskId: string; version: number; action: string; auditId: string } | null;
  requestTask: string; proofJti: string; operator: string; reason: string; dataReady: boolean;
  priceStatus: "unsupported"; requiredEvidence: readonly string[]; gaps: string[];
  identities: Array<{ alias: string; identityHash: string; spaceId: string; database: string; workspaceRole: string; billingRole: string; billingAccountRef: string; revoked: boolean }>;
  before: ActivitySnapshot | null; after: ActivitySnapshot | null; idempotentReplay: boolean;
};

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const unprocessable = (code: string, message: string) => new HttpError(422, code, message);

const REASON_MAX = 500;
/** 操作原因是审计必需项：非空、有界、无控制字符。 */
export function normalizeReason(reason: unknown): string {
  if (typeof reason !== "string") throw unprocessable("internal-ai-reason-invalid", "必须填写操作原因");
  const value = reason.trim();
  const control = [...value].some(ch => { const code = ch.codePointAt(0) ?? 0; return code < 0x20 || code === 0x7f; });
  if (!value || value.length > REASON_MAX || control) {
    throw unprocessable("internal-ai-reason-invalid", "操作原因必须为非空且无控制字符的短文本");
  }
  return value;
}

/** SCHEMAFULL 的 option<T> 字段必须“缺席”而不是 NULL：JS 的 null 会被序列化成 NULL 而被拒。 */
function compact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined));
}

function rows<T>(result: unknown): T[] {
  const first: unknown = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first as T[] : first && typeof first === "object" ? [first as T] : [];
}

/** 缺价目证书时必须给出的证据字段：调用方按名补证据，不允许猜价。 */
export const PRICE_REQUIRED_EVIDENCE = [
  "provider", "host", "path", "model", "currency", "inputNanoUsdPerToken", "cachedInputNanoUsdPerToken",
  "outputNanoUsdPerToken", "maxInputTokens", "maxOutputTokens", "cacheBillingRelation", "reasoningBillingRelation",
  "worstCaseNanoUsd", "certificateSource", "certificateSampledAt", "certificateExpiresAt",
] as const;

const ACTIVITY_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export class InternalAiRegistration {
  constructor(private readonly db: () => Promise<Queryable>) {}

  async revisions(activity: string): Promise<RevisionRow[]> {
    return rows<RevisionRow>(await (await this.db()).query(
      "SELECT * FROM internal_ai_revision WHERE activity = $activity ORDER BY revision", { activity },
    ));
  }

  async revision(activity: string, revision: number): Promise<RevisionRow | undefined> {
    return rows<RevisionRow>(await (await this.db()).query(
      "SELECT * FROM ONLY $id", { id: new RecordId("internal_ai_revision", `${activity}:${revision}`) },
    ))[0];
  }

  async identities(activity: string): Promise<IdentityRow[]> {
    return rows<IdentityRow>(await (await this.db()).query(
      "SELECT * FROM internal_ai_identity WHERE activity = $activity ORDER BY alias", { activity },
    ));
  }

  private async snapshot(activity: string): Promise<ActivitySnapshot | null> {
    const found = rows<Record<string, unknown>>(await (await this.db()).query("SELECT * FROM ONLY $id", {
      id: new RecordId("internal_ai_activity", activity),
    }))[0];
    if (!found) return null;
    return {
      enabled: found.enabled === true, goal: String(found.goal ?? GOAL),
      totalLimit: Number(found.total_limit ?? 0), perAttemptLimit: Number(found.per_attempt_limit ?? 0),
      attemptLimit: Number(found.attempt_limit ?? 0), reserved: Number(found.reserved ?? 0),
      spent: Number(found.spent ?? 0), attempts: Number(found.attempts ?? 0),
      approvalRevision: typeof found.approval_revision === "string" ? found.approval_revision : null,
      evidenceExpiresAt: typeof found.evidence_expires_at === "string" ? found.evidence_expires_at : null,
      priceRevisions: Array.isArray(found.price_revisions) ? found.price_revisions.map(String) : [],
      balanceNanoUsd: typeof found.balance_nano_usd === "number" ? found.balance_nano_usd : null,
      balanceCurrency: typeof found.balance_currency === "string" ? found.balance_currency : null,
      balanceSource: typeof found.balance_source === "string" ? found.balance_source : null,
      balanceSampledAt: typeof found.balance_sampled_at === "string" ? found.balance_sampled_at : null,
      balanceEvidenceHash: typeof found.balance_evidence_hash === "string" ? found.balance_evidence_hash : null,
      autoTopupDisabled: found.auto_topup_disabled === true, serviceApproved: found.service_approved === true,
    };
  }

  /** 双身份必须分别核对：owner/admin 与 member/participant 各一枚，同 workspace/账户、不同 subject。 */
  private assertIdentities(claims: CompanyProofClaims): void {
    const [owner, member] = claims.identities;
    if (!owner || !member) throw unprocessable("company-proof-identities-incomplete", "公司证明缺少完整身份投影");
    if (owner.subject === member.subject) throw unprocessable("company-proof-identities-invalid", "两枚身份不得为同一主体");
    if (owner.alias !== "LCA04_REMOVABLE" || member.alias !== "LCA04_MEMBER") {
      throw unprocessable("company-proof-identities-invalid", "身份别名与冻结契约不符");
    }
    if (owner.workspaceRole !== "admin" || owner.billingRole !== "owner" || member.workspaceRole !== "participant" || member.billingRole !== "member") {
      throw unprocessable("company-proof-identities-invalid", "身份角色与冻结契约不符");
    }
    if (owner.spaceId !== member.spaceId || owner.database !== member.database || owner.billingAccountRef !== member.billingAccountRef) {
      throw unprocessable("company-proof-identities-invalid", "两枚身份必须属于同一 workspace 与计费账户");
    }
    const declared = claims.manifest.identities;
    if (declared[0].alias !== owner.alias || declared[1].alias !== member.alias) {
      throw unprocessable("company-proof-identities-invalid", "身份投影与 manifest 声明不一致");
    }
  }

  /** subject 只以哈希落库；原文不进库、不进响应、不进日志。 */
  private identityHash(identity: CompanyProofClaims["identities"][number]): string {
    return hash(identity.subject, identity.database);
  }

  /**
   * 提交受审余额证据文档。
   *
   * 文档正文绝不落库：只校验其 sha256 **必须等于公司证明里的 documentHash**，
   * 再按严格 schema 解析并只记录脱敏字段。运营自填的 true / USD 1 因此不可能冒充证据——
 * 字节对不上公司签发的哈希即拒绝。
   */
  async submitEvidence(input: { activity: string; revision: number; document: string; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason);
    if (!ACTIVITY_ID.test(input.activity)) throw unprocessable("internal-ai-id-invalid", "活动标识无效");
    const bytes = Buffer.from(input.document, "utf8");
    if (bytes.length < 1 || bytes.length > REVIEWED_DOCUMENT_MAX_BYTES) {
      throw unprocessable("internal-ai-document-invalid", "证据文档大小超出受核定边界");
    }
    const target = await this.revision(input.activity, input.revision);
    if (!target) throw new HttpError(404, "internal-ai-revision-missing", "登记版本不存在");
    const documentHash = createHash("sha256").update(bytes).digest("hex");
    // 哈希绑定：文档字节必须就是公司证明所签的那一份，否则拒绝。
    if (documentHash !== target.document_hash) throw conflict("company-proof-evidence-mismatch", "证据文档与公司证明签发的文档摘要不一致");
    const parsed = reviewedEvidenceSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) throw unprocessable("internal-ai-document-invalid", "证据文档字段不合法或非 USD-only 契约");
    const evidence: ReviewedEvidence = parsed.data;
    // 跨文件一致性：账户/端点/模型/价目引用必须与 manifest 登记的一致。
    if (evidence.accountRef !== target.account_ref || evidence.endpoint !== target.endpoint
      || evidence.model !== target.model || evidence.priceRevision !== target.price_revision) {
      throw conflict("company-proof-evidence-mismatch", "证据文档与登记的服务标识不一致");
    }
    const db = await this.db();
    const before = await this.snapshot(input.activity);
    const next = (await this.revisions(input.activity)).at(-1)!.revision + 1;
    const row: RevisionRow = {
      activity: input.activity, revision: next, state: "disabled", proof_type: target.proof_type, goal: GOAL,
      project: COMPANY_PROOF_PROJECT, env: "production", operator: input.operator, reason,
      request_task: target.request_task, proof_jti: null, source_jti: target.proof_jti ?? target.source_jti, manifest_hash: target.manifest_hash,
      document_hash: documentHash, configuration_digest: target.configuration_digest,
      identities_digest: target.identities_digest, approval_task: target.approval_task,
      approval_version: target.approval_version, approval_action: target.approval_action,
      approval_audit_id: target.approval_audit_id, account_ref: evidence.accountRef, endpoint: evidence.endpoint,
      model: evidence.model, price_revision: evidence.priceRevision, currency: evidence.currency,
      balance_nano_usd: evidence.balanceNanoUsd, balance_sampled_at: evidence.sampledAt,
      evidence_expires_at: evidence.expiresAt, auto_topup_disabled: evidence.autoTopupDisabled,
      service_approved: evidence.serviceApproved, status_capability_hash: target.status_capability_hash,
      gaps: await this.evidenceGaps({ ...target, balance_nano_usd: evidence.balanceNanoUsd, currency: evidence.currency, balance_sampled_at: evidence.sampledAt, evidence_expires_at: evidence.expiresAt, auto_topup_disabled: evidence.autoTopupDisabled, service_approved: evidence.serviceApproved }),
      before, after: before,
    };
    await db.query("INSERT INTO internal_ai_revision $row;", { row: compact({ ...row, id: new RecordId("internal_ai_revision", `${input.activity}:${next}`) }) });
    return this.summary(row, undefined, false);
  }

  /**
   * 消费公司证明并登记。**永远先建 disabled**：development-disabled 证明不得带来任何付费许可；
   * 已启用的活动收到禁用证明时同样被禁用，且绝不触碰已用/预留/次数。
   */
  async register(input: { claims: CompanyProofClaims; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason);
    const claims = input.claims;
    this.assertIdentities(claims);
    const activity = claims.manifest.activityId;
    if (!ACTIVITY_ID.test(activity)) throw unprocessable("internal-ai-id-invalid", "活动标识无效");
    const db = await this.db();
    const existing = rows<RevisionRow>(await db.query(
      "SELECT * FROM internal_ai_revision WHERE proof_jti = $jti LIMIT 1", { jti: claims.jti },
    ))[0];
    if (existing) {
      // 同一证明重复投递：幂等返回；同 jti 不同摘要 → 冲突，禁止改写已登记证据。
      if (existing.configuration_digest !== claims.configurationDigest || existing.document_hash !== claims.documentHash) {
        throw conflict("company-proof-revision-conflict", "同一证明标识已登记不同证据");
      }
      return this.summary(existing, undefined, true);
    }
    for (const identity of claims.identities) {
      const bound = rows<{ activity: string; revoked: boolean }>(await db.query(
        "SELECT activity, revoked FROM internal_ai_binding WHERE identity_hash = $identity LIMIT 1",
        { identity: this.identityHash(identity) },
      ))[0];
      if (bound && bound.activity !== activity) throw conflict("internal-ai-identity-bound", "该身份已绑定其它活动");
      if (bound?.revoked) throw conflict("internal-ai-identity-revoked", "该身份已被撤销，不得重新绑定");
    }
    const latest = rows<{ revision: number }>(await db.query(
      "SELECT revision FROM internal_ai_revision WHERE activity = $activity ORDER BY revision DESC LIMIT 1", { activity },
    ))[0];
    const revision = (latest?.revision ?? 0) + 1;
    const before = await this.snapshot(activity);
    const manifest = claims.manifest;
    const now = new Date().toISOString();
    // 禁用登记不得继承付费授权：只改元数据与证据引用，reserved/spent/attempts 一律不动。
    await db.query(`INSERT INTO internal_ai_activity $row ON DUPLICATE KEY UPDATE
      goal = $input.goal, total_limit = $input.total_limit, per_attempt_limit = $input.per_attempt_limit,
      attempt_limit = $input.attempt_limit, enabled = false, approval_revision = NONE, evidence_expires_at = NONE,
      price_revisions = [], balance_nano_usd = NONE, balance_currency = NONE, balance_source = NONE,
      balance_sampled_at = NONE, balance_evidence_hash = NONE, auto_topup_disabled = $input.auto_topup_disabled,
      service_approved = false;`, {
      row: compact({
        id: new RecordId("internal_ai_activity", activity), goal: GOAL, enabled: false,
        total_limit: manifest.budget.totalNanoUsd, per_attempt_limit: manifest.budget.perAttemptNanoUsd,
        attempt_limit: manifest.budget.maxAttempts, price_revisions: [],
        auto_topup_disabled: manifest.budget.autoTopupDisabled, service_approved: false,
      }),
    });
    const revisionRow: RevisionRow = {
      activity, revision, state: "disabled", proof_type: claims.type, goal: GOAL,
      project: COMPANY_PROOF_PROJECT, env: "production", operator: input.operator, reason,
      request_task: claims.requestTask, proof_jti: claims.jti, source_jti: claims.jti,
      manifest_hash: hash(claims.jti, claims.configurationDigest), document_hash: claims.documentHash,
      configuration_digest: claims.configurationDigest, identities_digest: claims.identitiesDigest,
      approval_task: claims.approval?.taskId ?? null, approval_version: claims.approval?.version ?? null,
      approval_action: claims.approval?.action ?? null, approval_audit_id: claims.approval?.auditId ?? null,
      account_ref: manifest.service.accountRef, endpoint: manifest.service.endpoint, model: manifest.service.model,
      price_revision: manifest.service.priceRevision, currency: "USD", balance_nano_usd: null,
      balance_sampled_at: null, evidence_expires_at: null,
      auto_topup_disabled: manifest.budget.autoTopupDisabled, service_approved: false,
      status_capability_hash: statusCapabilityHash(claims.status.bearer),
      gaps: ["approved-service-evidence", "balance-evidence", "price-certificate"],
      before, after: await this.snapshot(activity),
    };
    await db.query("INSERT INTO internal_ai_revision $row;", { row: compact({ ...revisionRow, id: new RecordId("internal_ai_revision", `${activity}:${revision}`) }) });
    for (const identity of claims.identities) {
      const binding = {
        identity_hash: this.identityHash(identity), activity, alias: identity.alias, space_id: identity.spaceId,
        database: identity.database, workspace_role: identity.workspaceRole, billing_role: identity.billingRole,
        billing_account_ref: identity.billingAccountRef, revision, revoked: false,
      };
      // 同一身份只有一行：重复登记幂等刷新绑定，不新增、不清撤销标记。
      await db.query(`INSERT INTO internal_ai_identity $row ON DUPLICATE KEY UPDATE activity = $input.activity,
        revision = $input.revision, alias = $input.alias, space_id = $input.space_id, database = $input.database,
        workspace_role = $input.workspace_role, billing_role = $input.billing_role,
        billing_account_ref = $input.billing_account_ref;`, { row: compact(binding), input: compact(binding) });
      await db.query(`INSERT INTO internal_ai_binding $row ON DUPLICATE KEY UPDATE activity = $input.activity,
        alias = $input.alias, space_id = $input.space_id, database = $input.database,
        workspace_role = $input.workspace_role, billing_role = $input.billing_role,
        billing_account_ref = $input.billing_account_ref, revision = $input.revision;`, {
        row: compact({ ...binding, revision }), input: compact({ ...binding, revision }),
      });
    }
    return this.summary(revisionRow, claims, false);
  }

  /** 证据本身的缺口：类型/批准/余额/币种/时点/有效期/停自动充值/服务批准。 */
  private evidenceGaps(revision: RevisionRow): CompanyProofGap[] {
    const gaps: CompanyProofGap[] = [];
    if (revision.proof_type !== "reviewed-service" || !revision.approval_task) gaps.push("approved-service-evidence");
    if (revision.balance_nano_usd === null) gaps.push("balance-evidence");
    if (revision.currency !== "USD") gaps.push("balance-currency");
    if (revision.balance_nano_usd !== null && revision.balance_nano_usd <= 0) gaps.push("balance-positive");
    if (!revision.balance_sampled_at) gaps.push("balance-sampled-at");
    if (!revision.evidence_expires_at || Date.parse(revision.evidence_expires_at) <= Date.now()) gaps.push("evidence-not-expired");
    if (!revision.auto_topup_disabled) gaps.push("auto-topup-disabled");
    if (!revision.service_approved) gaps.push("service-approved");
    return [...new Set(gaps)];
  }

  /** enable 前置校验：证据 + 价目证书 + 身份绑定 + 当前生产连接，任一缺口即 fail-closed。 */
  async gapsFor(revision: RevisionRow, runtime: { provider?: string; model?: string; endpoint?: string }): Promise<CompanyProofGap[]> {
    const gaps: CompanyProofGap[] = [...this.evidenceGaps(revision)];
    if (revision.state !== "disabled") gaps.push("approved-service-evidence");
    if (!certificateFor(revision.endpoint, revision.model)) gaps.push("price-certificate");
    const identities = await this.identities(revision.activity);
    // 身份必须在该 revision 之前（或当时）绑定：旧绑定不能替新 revision 授权。
    if (identities.length !== 2 || identities.some(i => i.revision > revision.revision)) gaps.push("identity-binding");
    if (identities.some(i => i.revoked)) gaps.push("identity-revoked");
    // 活动配置不得自报价格或扩大模型/host/窗口：必须与当前生产连接一致。
    if (!runtime.provider || !runtime.model || !runtime.endpoint) gaps.push("price-certificate");
    else if (runtime.model !== revision.model || endpointHost(runtime.endpoint) !== endpointHost(revision.endpoint)) {
      gaps.push("price-certificate");
    }
    return [...new Set(gaps)];
  }

  /** 显式启用：证据齐全才放行；只置授权与证据，绝不重置已用/预留/次数。 */
  async enable(input: { activity: string; revision: number; operator: string; reason: string; runtime: { provider?: string; model?: string; endpoint?: string } }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason);
    if (!ACTIVITY_ID.test(input.activity)) throw unprocessable("internal-ai-id-invalid", "活动标识无效");
    const revision = await this.revision(input.activity, input.revision);
    if (!revision) throw new HttpError(404, "internal-ai-revision-missing", "登记版本不存在");
    const gaps = await this.gapsFor(revision, input.runtime);
    if (gaps.length > 0) throw unprocessable("internal-ai-enable-denied", `启用证据不足：${gaps.join(", ")}`);
    const tariff = certificateFor(revision.endpoint, revision.model) as Tariff;
    const limits = await this.limitsOf(input.activity);
    if (limits.perAttemptNanoUsd < worstCost(tariff)) throw unprocessable("internal-ai-enable-denied", "单次上限低于该证书最坏费用");
    if (revision.balance_nano_usd === null || limits.totalNanoUsd < revision.balance_nano_usd) {
      throw unprocessable("internal-ai-enable-denied", "活动总上限高于已核定余额");
    }
    const db = await this.db();
    const before = await this.snapshot(input.activity);
    await db.query(`UPDATE ONLY $activity SET enabled = true, approval_revision = $approval,
      evidence_expires_at = $expires, price_revisions = $revisions, balance_nano_usd = $balance,
      balance_currency = "USD", balance_source = $source, balance_sampled_at = $sampled,
      balance_evidence_hash = $hash, auto_topup_disabled = true, service_approved = true;`, {
      activity: new RecordId("internal_ai_activity", input.activity),
      approval: `${revision.approval_task}@${revision.approval_version}`,
      expires: revision.evidence_expires_at, revisions: [tariff.revision], balance: revision.balance_nano_usd,
      source: `reviewed-document:${revision.document_hash}`, sampled: revision.balance_sampled_at, hash: revision.document_hash,
    });
    const next = (await this.revisions(input.activity)).at(-1)!.revision + 1;
    const row: RevisionRow = {
      activity: input.activity, revision: next, state: "enabled", proof_type: revision.proof_type, goal: GOAL,
      project: COMPANY_PROOF_PROJECT, env: "production", operator: input.operator, reason,
      request_task: revision.request_task, proof_jti: null, source_jti: revision.proof_jti ?? revision.source_jti, manifest_hash: revision.manifest_hash,
      document_hash: revision.document_hash, configuration_digest: revision.configuration_digest,
      identities_digest: revision.identities_digest, approval_task: revision.approval_task,
      approval_version: revision.approval_version, approval_action: revision.approval_action,
      approval_audit_id: revision.approval_audit_id, account_ref: revision.account_ref,
      endpoint: revision.endpoint, model: revision.model, price_revision: tariff.revision, currency: "USD",
      balance_nano_usd: revision.balance_nano_usd, balance_sampled_at: revision.balance_sampled_at,
      evidence_expires_at: revision.evidence_expires_at, auto_topup_disabled: true, service_approved: true,
      status_capability_hash: revision.status_capability_hash, gaps: [], before,
      after: await this.snapshot(input.activity),
    };
    await db.query("INSERT INTO internal_ai_revision $row;", { row: compact({ ...row, id: new RecordId("internal_ai_revision", `${input.activity}:${next}`) }) });
    return this.summary(row, undefined, false);
  }

  /** 显式禁用：保留历史与账本，只置 enabled=false 并追加 revision。 */
  async disable(input: { activity: string; operator: string; reason: string }): Promise<RegistrationSummary> {
    const reason = normalizeReason(input.reason);
    if (!ACTIVITY_ID.test(input.activity)) throw unprocessable("internal-ai-id-invalid", "活动标识无效");
    const db = await this.db();
    const before = await this.snapshot(input.activity);
    if (!before) throw new HttpError(404, "internal-ai-unconfigured", "内部活动尚未受审配置");
    await db.query("UPDATE ONLY $activity SET enabled = false;", { activity: new RecordId("internal_ai_activity", input.activity) });
    const latest = (await this.revisions(input.activity)).at(-1);
    const next = (latest?.revision ?? 0) + 1;
    const row: RevisionRow = {
      activity: input.activity, revision: next, state: "disabled",
      proof_type: latest?.proof_type ?? "development-disabled", goal: GOAL, project: COMPANY_PROOF_PROJECT,
      env: "production", operator: input.operator, reason, request_task: latest?.request_task ?? "",
      proof_jti: null, source_jti: latest?.proof_jti ?? latest?.source_jti ?? null, manifest_hash: latest?.manifest_hash ?? "",
      document_hash: latest?.document_hash ?? "", configuration_digest: latest?.configuration_digest ?? "",
      identities_digest: latest?.identities_digest ?? "", approval_task: latest?.approval_task ?? null,
      approval_version: latest?.approval_version ?? null, approval_action: latest?.approval_action ?? null,
      approval_audit_id: latest?.approval_audit_id ?? null, account_ref: latest?.account_ref ?? "",
      endpoint: latest?.endpoint ?? "", model: latest?.model ?? "", price_revision: latest?.price_revision ?? "",
      currency: "USD", balance_nano_usd: latest?.balance_nano_usd ?? null,
      balance_sampled_at: latest?.balance_sampled_at ?? null, evidence_expires_at: latest?.evidence_expires_at ?? null,
      auto_topup_disabled: latest?.auto_topup_disabled ?? false, service_approved: false,
      status_capability_hash: latest?.status_capability_hash ?? null, gaps: ["approved-service-evidence"],
      before, after: await this.snapshot(input.activity),
    };
    await db.query("INSERT INTO internal_ai_revision $row;", { row: compact({ ...row, id: new RecordId("internal_ai_revision", `${input.activity}:${next}`) }) });
    return this.summary(row, undefined, false);
  }

  /** 撤销身份：只置持久标记，不删行、不重置账本、不释放 uncertain 成本。 */
  async revokeIdentity(input: { alias: "LCA04_REMOVABLE" | "LCA04_MEMBER"; activity: string; operator: string; reason: string }): Promise<{ alias: string; identityHash: string; activity: string; revoked: true }> {
    const reason = normalizeReason(input.reason);
    if (!ACTIVITY_ID.test(input.activity)) throw unprocessable("internal-ai-id-invalid", "活动标识无效");
    const db = await this.db();
    // 同一别名可能出现在多个活动里：必须同时指定活动，否则拒绝而不是猜一个。
    const found = rows<IdentityRow>(await db.query(
      "SELECT * FROM internal_ai_identity WHERE alias = $alias AND activity = $activity ORDER BY registered_at DESC LIMIT 2",
      { alias: input.alias, activity: input.activity },
    ));
    const binding = found[0];
    if (!binding) throw new HttpError(404, "internal-ai-identity-missing", "尚未登记该别名身份");
    if (found.length !== 1) throw conflict("internal-ai-identity-ambiguous", "该别名存在多条登记记录");
    if (binding.revoked) throw conflict("internal-ai-identity-revoked", "该身份已被撤销");
    await db.query("UPDATE internal_ai_identity SET revoked = true, revoked_at = time::now(), revoke_reason = $reason WHERE identity_hash = $identity;",
      { reason, identity: binding.identity_hash });
    await db.query("UPDATE internal_ai_binding SET revoked = true, revoked_at = time::now(), revoke_reason = $reason WHERE identity_hash = $identity;",
      { reason, identity: binding.identity_hash });
    return { alias: input.alias, identityHash: binding.identity_hash, activity: binding.activity, revoked: true };
  }

  private async limitsOf(activity: string): Promise<{ totalNanoUsd: number; perAttemptNanoUsd: number }> {
    const found = rows<{ total_limit: number; per_attempt_limit: number }>(await (await this.db()).query(
      "SELECT total_limit, per_attempt_limit FROM ONLY $id", { id: new RecordId("internal_ai_activity", activity) },
    ))[0];
    return { totalNanoUsd: Number(found?.total_limit ?? 0), perAttemptNanoUsd: Number(found?.per_attempt_limit ?? 0) };
  }

  private async summary(row: RevisionRow, claims: CompanyProofClaims | undefined, idempotentReplay: boolean): Promise<RegistrationSummary> {
    const identities = await this.identities(row.activity);
    const approved = row.proof_type === "reviewed-service" && row.approval_task !== null;
    const limits = claims
      ? { totalNanoUsd: claims.manifest.budget.totalNanoUsd, perAttemptNanoUsd: claims.manifest.budget.perAttemptNanoUsd, maxAttempts: claims.manifest.budget.maxAttempts }
      : await this.limitsOf(row.activity).then(l => ({ totalNanoUsd: l.totalNanoUsd, perAttemptNanoUsd: l.perAttemptNanoUsd, maxAttempts: 0 }));
    return {
      activity: row.activity, revision: row.revision, state: row.state, proofType: row.proof_type,
      configurationDigest: row.configuration_digest, documentHash: row.document_hash, manifestHash: row.manifest_hash,
      accountRef: row.account_ref, endpoint: row.endpoint, endpointHost: endpointHost(row.endpoint),
      model: row.model, priceRevision: row.price_revision, currency: "USD", balanceNanoUsd: row.balance_nano_usd,
      sampledAt: row.balance_sampled_at, expiresAt: row.evidence_expires_at,
      autoTopupDisabled: row.auto_topup_disabled, serviceApproved: row.service_approved, paidCallsAllowed: 0,
      limits,
      approval: row.approval_task && row.approval_version && row.approval_action && row.approval_audit_id
        ? { taskId: row.approval_task, version: row.approval_version, action: row.approval_action, auditId: row.approval_audit_id }
        : null,
      requestTask: row.request_task, proofJti: row.source_jti ?? row.proof_jti ?? "", operator: row.operator, reason: row.reason,
      dataReady: approved && Boolean(certificateFor(row.endpoint, row.model)) && row.balance_nano_usd !== null,
      priceStatus: "unsupported", requiredEvidence: PRICE_REQUIRED_EVIDENCE, gaps: row.gaps,
      identities: identities.map(i => ({
        alias: i.alias, identityHash: i.identity_hash, spaceId: i.space_id, database: i.database,
        workspaceRole: i.workspace_role, billingRole: i.billing_role, billingAccountRef: i.billing_account_ref, revoked: i.revoked,
      })),
      before: row.before, after: row.after, idempotentReplay,
    };
  }
}
