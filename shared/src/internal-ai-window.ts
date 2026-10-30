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

export type MagpieRoute = z.infer<typeof magpieRouteSchema>;
export type MagpieCapacity = z.infer<typeof magpieCapacitySchema>;
export type MagpieWindowCreate = z.infer<typeof magpieWindowCreateSchema>;
export type MagpieWindowBind = z.infer<typeof magpieWindowBindSchema>;

/** API 投影：不含 operator subject、密钥或任何正文。 */
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
  route: {
    revision: string;
    digest: string;
    requestedModel: string;
    servedModel: string;
    endpointHost: string | null;
    accountBinding: string;
    priceRevision: string;
    priceBasis: MagpieWindowPriceBasis;
    amortizedNanoUsd: number | null;
    marginalNanoUsd: number | null;
    sampledAt: string;
    expiresAt: string;
  };
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
