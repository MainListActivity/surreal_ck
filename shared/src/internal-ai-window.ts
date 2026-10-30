import { z } from "zod";

/**
 * FV06 Magpie 受控新窗口契约 v1：产品与公司证据链
 * （0ec530ce -> 571b1bb2 -> ffdae0f3）共享的唯一线上形状。
 *
 * 本契约只描述「批准摘要 + 证据期 + 源预算 + 路由/容量声明」如何被产品受控接收；
 * 它不签发批准、不证明供应商免费/订阅、不创建容量。产品只负责：
 * - 拒绝旧周期/旧 proof/过期证据/超出剩余次数；
 * - 冻结真实路由 revision/digest、requested/served model、账号绑定；
 * - 逐请求记录 provider usage 原件、requestId、run/attempt/retry/失败关联与价格依据；
 * - 未知成本/路由漂移/缺 usage 时 null 或闭锁，绝不把 null 当 0。
 */
export const MAGPIE_WINDOW_CONTRACT_VERSION = "magpie-window/v1";
export const MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS = 30;
export const MAGPIE_B_ENVELOPE = {
  id: "fv06-b-2026-11-05",
  goal: "e159e40ad4e50080",
  maxAttempts: 20,
  totalNanoUsd: 700_000_000,
  perAttemptNanoUsd: 35_000_000,
  expiresAt: "2026-11-05T12:10:07Z",
  approvalRefs: ["b796de49", "4e2ac8dd"],
} as const;
export const MAGPIE_WINDOW_PRICE_BASES = ["free-evidence", "per-token", "subscription-amortized", "unknown"] as const;
export type MagpieWindowPriceBasis = (typeof MAGPIE_WINDOW_PRICE_BASES)[number];

/**
 * FV06 远端窗口契约 v2：接收公司已批准的 remote-magpie-evidence/1 证据形状
 * （route.revision/digest/expiresAt 为 null+gap，routingConfigurationVerified=false）。
 * v2 不放宽校验，而是把「本地观测」与「远端元数据」分层冻结：
 * - 观测层（capturedAt/observation digest/7200s 本地新鲜度）绝不写入远端 route 字段；
 * - 远端没给的字段保持 null 并要求一一对应的 gap 声明，不得以本地摘要/期限冒充；
 * - requestedModel/endpoint 由受控运行配置与证据来源交叉核对后冻结，不从缺字段猜值；
 * - 价格独立硬门禁：reviewed=false 的目录 0/0 一律 unknown（请求门禁闭锁），
 *   永不自动等于 free-evidence；reviewed=true 也须命中产品已核价目证书。
 * v1 契约与既有窗口行保持原语义；历史行以 contract_version 缺失视为 v1。
 */
export const MAGPIE_REMOTE_WINDOW_CONTRACT_VERSION = "magpie-window/v2";
export const MAGPIE_REMOTE_EVIDENCE_VERSION = "remote-magpie-evidence/1";
/** 本地观测新鲜度策略：证据期 = 采集时刻 + 7200s（与公司执行窗口径一致，不变）。 */
export const MAGPIE_LOCAL_FRESHNESS_SECONDS = 7200;

/** 9e44a95d 已批容量 scope 的硬上限；产品只记录/校验，不据此造容量。 */
export const MAGPIE_CAPACITY_SCOPE = {
  database: "ws_ddad14a98469",
  minEntityTables: 3,
  maxEntityTables: 5,
  maxFieldsPerTable: 23,
  maxRecordsPerTable: 24,
  maxTtlSeconds: 24 * 60 * 60,
} as const;

/** 旧周期/旧批准/旧 proof 的已知前缀：新窗口输入一旦命中即拒绝，禁止换字段复活。 */
export const MAGPIE_WINDOW_LEGACY_PREFIXES = ["a7537d2c", "f3974e8f", "4fff2947"] as const;

const digest = z.string().regex(/^[0-9a-f]{64}$/, "必须是 64 位小写十六进制 sha256");
const activityId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "活动标识无效");
const isoInstant = z.string().datetime({ offset: true });

export const magpieRouteSchema = z.object({
  revision: z.string().min(1).max(100),
  digest: digest,
  requestedModel: z.string().min(1).max(200),
  servedModel: z.string().min(1).max(200),
  /** 完整端点（scheme/host/port/path）；不是秘密，但必须由受控来源给出。 */
  endpoint: z.string().url().max(500),
  accountBinding: z.string().min(1).max(200),
  priceRevision: z.string().min(1).max(100),
  priceBasis: z.enum(MAGPIE_WINDOW_PRICE_BASES),
  freeEvidenceHash: digest.optional(),
  amortizedNanoUsd: z.number().int().min(0).optional(),
  marginalNanoUsd: z.number().int().min(0).optional(),
  maxOutputTokens: z.number().int().positive().max(65536),
  sampledAt: isoInstant,
  expiresAt: isoInstant,
}).strict();

export const magpieCapacitySchema = z.object({
  database: z.literal(MAGPIE_CAPACITY_SCOPE.database),
  entityTables: z.number().int().min(MAGPIE_CAPACITY_SCOPE.minEntityTables).max(MAGPIE_CAPACITY_SCOPE.maxEntityTables),
  fieldsPerTable: z.number().int().min(1).max(MAGPIE_CAPACITY_SCOPE.maxFieldsPerTable),
  recordsPerTable: z.number().int().min(1).max(MAGPIE_CAPACITY_SCOPE.maxRecordsPerTable),
  ttlSeconds: z.number().int().min(1).max(MAGPIE_CAPACITY_SCOPE.maxTtlSeconds),
  destructive: z.literal(false),
  /** 9e44a95d 批准项引用；无有效来源不得造容量。 */
  source: z.string().min(1).max(200),
}).strict();

export const magpieWindowCreateSchema = z.object({
  activity: activityId,
  approvalDigest: digest,
  approvalTask: z.string().min(1).max(100),
  accountRef: z.string().min(1).max(200),
  evidenceExpiresAt: isoInstant,
  envelope: z.literal(MAGPIE_B_ENVELOPE.id).optional(),
  sourceBudgetAttempts: z.number().int().min(1).max(MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS),
  sourceBudgetNanoUsd: z.number().int().min(1).max(1_000_000_000),
  perAttemptNanoUsd: z.number().int().min(1).max(100_000_000),
  route: magpieRouteSchema,
  capacity: magpieCapacitySchema,
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().min(1).max(500),
}).strict();

export const magpieWindowBindSchema = z.object({
  activity: activityId,
  expectedRevision: z.number().int().positive(),
  reason: z.string().min(1).max(500),
}).strict();

// ── 远端窗口契约 v2（remote-magpie-evidence/1）────────────────────────────

/** 缺口声明：远端未提供的字段必须逐项给出原因；代码侧校验 null ⟺ gap 一一对应。 */
export const magpieRemoteGapSchema = z.object({
  field: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
}).strict();

const nullableDigest = digest.nullable();
const nullableInstant = isoInstant.nullable();

/**
 * 远端证据投影：只接收产品窗口需要冻结的字段；author/usage/coverage 属公司侧
 * 证据链材料，不进产品窗口，原件由 approvalDigest + configurationDigest 锚定。
 */
export const magpieRemoteEvidenceSchema = z.object({
  version: z.literal(MAGPIE_REMOTE_EVIDENCE_VERSION),
  source: z.object({
    kind: z.literal("configured-remote-magpie"),
    endpoint: z.string().url().max(500),
    model: z.string().min(1).max(200),
    executionHost: z.literal("remote"),
  }).strict(),
  observation: z.object({
    capturedAt: isoInstant,
    /** 本地观测快照摘要：观测层证据，绝不冒充远端 route digest。 */
    digest: digest,
    routingConfigurationVerified: z.literal(false),
  }).strict(),
  accountRef: z.string().min(1).max(200),
  accountBinding: z.string().min(1).max(200),
  route: z.object({
    present: z.literal(true),
    group: z.string().min(1).max(200),
    revision: z.string().max(200).nullable(),
    digest: nullableDigest,
    servedModel: z.string().min(1).max(200),
    /** 历史 usage 行时间，如实保留；不是本地观测时刻，不参与新鲜度计算。 */
    sampledAt: isoInstant,
    expiresAt: nullableInstant,
    gaps: z.array(magpieRemoteGapSchema).max(10),
  }).strict(),
  pricing: z.object({
    priceRevision: z.string().min(1).max(200),
    rawPrompt: z.string().max(100),
    rawCompletion: z.string().max(100),
    free: z.boolean(),
    freeEvidence: z.string().max(200).optional(),
    reviewed: z.boolean(),
  }).strict(),
  expiry: z.object({
    basis: z.literal("local-observation-freshness-policy"),
    localFreshnessExpiresAt: isoInstant,
    /** 远端给出的到期时刻列表；空数组 = 远端未提供，不得由本地代填。 */
    sourceExpiresAt: z.array(isoInstant).max(10),
    expiresAt: isoInstant,
  }).strict(),
  budget: z.object({
    currency: z.literal("USD"),
    totalNanoUsd: z.number().int().min(1).max(1_000_000_000),
    perAttemptNanoUsd: z.number().int().min(1).max(100_000_000),
    maxAttempts: z.number().int().min(1).max(MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS),
  }).strict(),
  gaps: z.array(magpieRemoteGapSchema).max(10),
  configurationDigest: digest,
}).strict();

/**
 * 远端窗口创建输入：预算/容量/账号与 v1 同语义；路由元数据来自证据（可为 null+gap），
 * requestedModel/endpoint 由服务端受控运行配置交叉核对（输入不带，防止伪造路由）。
 */
export const magpieRemoteWindowCreateSchema = z.object({
  activity: activityId,
  approvalDigest: digest,
  approvalTask: z.string().min(1).max(100),
  accountRef: z.string().min(1).max(200),
  evidenceExpiresAt: isoInstant,
  sourceBudgetAttempts: z.number().int().min(1).max(MAGPIE_WINDOW_MAX_TOTAL_ATTEMPTS),
  sourceBudgetNanoUsd: z.number().int().min(1).max(1_000_000_000),
  perAttemptNanoUsd: z.number().int().min(1).max(100_000_000),
  maxOutputTokens: z.number().int().positive().max(65536),
  evidence: magpieRemoteEvidenceSchema,
  capacity: magpieCapacitySchema,
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().min(1).max(500),
}).strict();

export type MagpieRemoteGap = z.infer<typeof magpieRemoteGapSchema>;
export type MagpieRemoteEvidence = z.infer<typeof magpieRemoteEvidenceSchema>;
export type MagpieRemoteWindowCreate = z.infer<typeof magpieRemoteWindowCreateSchema>;

export type MagpieRoute = z.infer<typeof magpieRouteSchema>;
export type MagpieCapacity = z.infer<typeof magpieCapacitySchema>;
export type MagpieWindowCreate = z.infer<typeof magpieWindowCreateSchema>;
export type MagpieWindowBind = z.infer<typeof magpieWindowBindSchema>;

/** API 投影：不含 operator subject、密钥或任何正文。v1 行的新增字段为 null。 */
export type MagpieWindowView = {
  id: string;
  activity: string;
  status: string;
  revision: number;
  approvalDigest: string;
  approvalTask: string;
  accountRef: string;
  evidenceExpiresAt: string;
  envelope: string | null;
  attempts: number;
  attemptLimit: number;
  reserved: number;
  spent: number;
  contractVersion: string;
  evidenceVersion: string | null;
  /** 观测层（v2 远端窗口）：快照摘要/采集时刻/路由配置核实声明，与远端元数据分层。 */
  observation: { capturedAt: string; digest: string | null; routingConfigurationVerified: boolean | null } | null;
  /** null+gap 缺口声明（v2）：与 route.revision/digest/expiresAt 的 null 一一对应。 */
  routeGaps: MagpieRemoteGap[] | null;
  route: {
    revision: string | null;
    digest: string | null;
    requestedModel: string;
    servedModel: string;
    endpointHost: string | null;
    accountBinding: string;
    priceRevision: string;
    priceBasis: MagpieWindowPriceBasis;
    amortizedNanoUsd: number | null;
    marginalNanoUsd: number | null;
    sampledAt: string;
    expiresAt: string | null;
    provider: string | null;
  };
  /** 本地新鲜度层（v2）：与远端到期时刻分列，绝不写入 route.expiresAt。 */
  expiry: { basis: string | null; localFreshnessExpiresAt: string | null; sourceExpiresAt: string[] } | null;
  /** 价目证据层（v2）：远端目录修订与人工复核状态；不等于已核价目。 */
  priceEvidence: { evidenceRevision: string | null; reviewed: boolean | null } | null;
  capacity: {
    database: string;
    entityTables: number;
    fieldsPerTable: number;
    recordsPerTable: number;
    ttlSeconds: number;
    destructive: boolean;
    source: string;
  };
  createdAt: string | null;
  boundAt: string | null;
};
