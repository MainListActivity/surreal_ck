import { z } from "zod";

/**
 * 公司内部AI可信证明的冻结消费契约。
 *
 * 这一份是**产品侧**对公司运营程序（surreal-ck-operations 的 ops 内部AI证明桥接）所出具
 * EdDSA 证明的**验签与字段约束**。信任锚是公钥材料（不是 secret），按 kid/JWK pin 固定；
 * 公司侧轮换 key 时必须同步改这里并随发布上线，不存在运行期可替换的信任源。
 *
 * 与公司侧公开契约逐字对齐的常量：
 * - PROOF_ISSUER / PROOF_AUDIENCE（公司 `src/ops/proof-contract.ts`）
 * - header `typ` = `sck-internal-ai-proof+jwt`、`alg` = `EdDSA`（公司 `src/ops/proof-signer.ts`）
 * - 证明最长 300 秒、状态最长 60 秒
 */

export const COMPANY_PROOF_ISSUER = "urn:surreal-ck:company:internal-ai:v1";
export const COMPANY_PROOF_AUDIENCE = "urn:surreal-ck:surreal_ck:production:internal-ai:v1";
export const COMPANY_PROOF_TYP = "sck-internal-ai-proof+jwt";
export const COMPANY_PROOF_ALG = "EdDSA";
export const COMPANY_PROOF_MAX_AGE_SECONDS = 300;
export const COMPANY_PROOF_MAX_BYTES = 32_000;

/** 公司 goal 与项目标识：与内部AI预算门禁同一目标，不接受其它目标的活动证明。 */
export const COMPANY_PROOF_GOAL = "2e2a6e41c1193595";
export const COMPANY_PROOF_PROJECT = "surreal_ck";

/** 固定 kid 与公钥 JWK。轮换只能改代码并发布，不允许 env 覆盖。 */
export const COMPANY_PROOF_TRUST = {
  alg: COMPANY_PROOF_ALG,
  kid: "0719aac25150983bd6d3880ade42ddc1",
  jwk: { crv: "Ed25519", x: "t6pCNI7dk-wP10MJ-2o_WMSFGGUvApmbqmWjysJv9h8", kty: "OKP" },
} as const;

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const boundedRef = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** 公司侧 model 是有界安全标识：非空安全片段以单点号分隔，长度 1..128，拒绝空白/斜杠/URL/Unicode。 */
const model = z.string().max(128).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?![\s\S])/);

/** manifest 与 evidence 的 model 必须一致，且端点/账户/价目引用跨文件相同。 */
export const companyProofManifestSchema = z.object({
  schemaVersion: z.literal(1),
  goalId: z.literal(COMPANY_PROOF_GOAL),
  project: z.literal(COMPANY_PROOF_PROJECT),
  env: z.literal("production"),
  activityId: boundedRef,
  workspaceSlug: z.string().regex(/^[a-z0-9-]{1,40}$/),
  documentHash: hex64,
  service: z.object({
    accountRef: boundedRef,
    endpoint: z.string().url().refine(v => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !u.port;
    }),
    model,
    priceRevision: boundedRef,
  }).strict(),
  budget: z.object({
    currency: z.literal("USD"),
    totalNanoUsd: z.number().int().positive().max(1_000_000_000),
    perAttemptNanoUsd: z.number().int().positive().max(100_000_000),
    maxAttempts: z.number().int().positive().max(30),
    autoTopupDisabled: z.literal(true),
  }).strict(),
  identities: z.tuple([
    z.object({ alias: z.literal("LCA04_REMOVABLE"), workspaceRole: z.literal("admin"), billingRole: z.literal("owner") }).strict(),
    z.object({ alias: z.literal("LCA04_MEMBER"), workspaceRole: z.literal("participant"), billingRole: z.literal("member") }).strict(),
  ]),
  configurationDigest: hex64,
}).strict();
export type CompanyProofManifest = z.infer<typeof companyProofManifestSchema>;

/** 已核定的身份投影：subject 只以哈希形式落库，绝不原文外泄。 */
export const companyProofIdentitySchema = z.object({
  alias: z.enum(["LCA04_REMOVABLE", "LCA04_MEMBER"]),
  subject: z.string().min(1).max(200),
  spaceId: z.string().min(1).max(200),
  database: z.string().regex(/^[a-z0-9_]{1,128}$/),
  workspaceRole: z.enum(["admin", "participant"]),
  billingRole: z.enum(["owner", "member"]),
  billingAccountRef: z.string().min(1).max(200),
}).strict();
export type CompanyProofIdentity = z.infer<typeof companyProofIdentitySchema>;

const leaseSchema = z.object({
  goal: z.literal(COMPANY_PROOF_GOAL),
  project: z.literal(COMPANY_PROOF_PROJECT),
  role: z.enum(["engineering", "product", "qa"]),
  employee: z.string().min(1).max(200),
  taskId: boundedRef,
  delivery: z.string().min(1).max(200),
  fence: z.number().int().nonnegative(),
}).strict();

const approvalSchema = z.object({
  taskId: boundedRef,
  version: z.number().int().positive(),
  action: z.enum(["accept", "owner_approve"]),
  auditId: z.string().min(1).max(200),
  reviewer: z.string().min(1).max(200),
  digest: hex64,
}).strict();

/** 公司 proof JWT 的 claims：与公司 proof-bridge 的 sign('proof', …) 载荷一一对应。 */
export const companyProofClaimsSchema = z.object({
  contractVersion: z.literal(1),
  /** development-disabled 只允许登记，不允许启用；approved-service 才可走 enable。 */
  type: z.enum(["development-disabled", "approved-service"]),
  paidCallsAllowed: z.union([z.literal(0), z.literal(1)]),
  scope: z.enum(["register-disabled", "enable"]),
  project: z.literal(COMPANY_PROOF_PROJECT),
  env: z.literal("production"),
  goal: z.literal(COMPANY_PROOF_GOAL),
  requestTask: boundedRef,
  lease: leaseSchema,
  approval: approvalSchema.nullable(),
  documentHash: hex64,
  manifest: companyProofManifestSchema,
  configurationDigest: hex64,
  identities: z.tuple([companyProofIdentitySchema, companyProofIdentitySchema]),
  identitiesDigest: hex64,
  jti: z.string().min(1).max(200),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  iat: z.number().int(),
  exp: z.number().int(),
  status: z.object({ path: z.literal("/internal-ai/status"), bearer: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  iss: z.literal(COMPANY_PROOF_ISSUER),
  aud: z.literal(COMPANY_PROOF_AUDIENCE),
}).strict();
export type CompanyProofClaims = z.infer<typeof companyProofClaimsSchema>;

/** 公司 `ops_internal_ai_deliver` 投递到 `/api/ops/internal-ai/company-proof` 的请求体。 */
export const companyProofEnvelopeSchema = z.object({ proof: z.string().min(1).max(COMPANY_PROOF_MAX_BYTES) }).strict();

/**
 * 受审余额证据文档（公司侧 evidenceSchema 的等价物）。
 * 这是运营提交的**真实可核定文档**：产品只存其 sha256 与脱敏字段，不存正文；
 * 哈希必须等于公司证明里的 documentHash，否则运营自填的 true / USD 1 一律无效。
 */
export const reviewedEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.enum(["development-disabled", "reviewed-service"]),
  accountRef: boundedRef,
  endpoint: z.string().url().refine(v => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !u.port;
  }),
  model,
  priceRevision: boundedRef,
  currency: z.literal("USD"),
  balanceNanoUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sampledAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  autoTopupDisabled: z.literal(true),
  serviceApproved: z.boolean(),
}).strict();
export type ReviewedEvidence = z.infer<typeof reviewedEvidenceSchema>;

/** 提交证据文档的请求体上限：与公司侧读取边界一致（256KiB），且正文绝不落库。 */
export const REVIEWED_DOCUMENT_MAX_BYTES = 256 * 1024;

export const reviewedDocumentEnvelopeSchema = z.object({
  revision: z.number().int().positive(),
  document: z.string().min(1).max(REVIEWED_DOCUMENT_MAX_BYTES),
  reason: z.string().min(1).max(500),
}).strict();

/** enable 前置校验失败时返回的缺口清单：调用方按字段名补证据，不允许猜。 */
export const companyProofGapSchema = z.array(z.enum([
  "approved-service-evidence",
  "balance-evidence",
  "balance-currency",
  "balance-positive",
  "balance-sampled-at",
  "evidence-not-expired",
  "auto-topup-disabled",
  "service-approved",
  "price-certificate",
  "identity-binding",
  "identity-revoked",
  "budget-bounds",
]));
export type CompanyProofGap = z.infer<typeof companyProofGapSchema>[number];
