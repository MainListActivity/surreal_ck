import { z } from "zod";

export const CONTENT_ACTIONS = ["browse", "search", "read", "cite", "export"] as const;
export const AI_TEMPLATE_ACTIONS = ["research", "generate"] as const;
export const PRODUCT_ENTITLEMENT_RESOLVER_VERSION = "product-entitlement-v1";

/** 来源许可可登记的全部动作：四个运营动词 + discover 公开投影 + 全部客户动作（含 AI）。 */
export const SOURCE_LICENSE_ACTIONS = [
  "submit", "publish", "withdraw", "restore",
  // discover：许可允许该来源进入公开发现投影（只暴露安全元数据，不暴露正文）。
  "discover",
  ...CONTENT_ACTIONS,
  ...AI_TEMPLATE_ACTIONS,
] as const;

const collectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,64}$/u),
  label: z.string().trim().min(1).max(80),
}).strict();

const featureSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,64}$/u),
  enabled: z.boolean(),
  limit: z.number().int().nonnegative().nullable(),
}).strict();

export const publishProductRevisionSchema = z.object({
  planKey: z.string().regex(/^[a-z][a-z0-9_]{2,64}$/u),
  displayName: z.string().trim().min(1).max(80),
  revision: z.number().int().positive(),
  resourceTemplateId: z.string().startsWith("quota_plan_revision:"),
  collections: z.array(collectionSchema).max(32),
  actions: z.array(z.enum(CONTENT_ACTIONS)).max(CONTENT_ACTIONS.length),
  aiActions: z.array(z.enum(AI_TEMPLATE_ACTIONS)).max(AI_TEMPLATE_ACTIONS.length),
  features: z.array(featureSchema).max(32),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export const assignProductEntitlementSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  billingAccountKey: z.string().trim().min(1).max(128),
  productPlanRevisionId: z.string().startsWith("product_plan_revision:"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export const grantContentCollectionSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(80),
  collections: z.array(collectionSchema).min(1).max(32),
  actions: z.array(z.enum(CONTENT_ACTIONS)).min(1),
  effectiveFrom: z.string().datetime(),
  effectiveUntil: z.string().datetime().nullable(),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type PublishProductRevision = z.infer<typeof publishProductRevisionSchema>;
export type AssignProductEntitlement = z.infer<typeof assignProductEntitlementSchema>;
export type GrantContentCollection = z.infer<typeof grantContentCollectionSchema>;

/** LCA13：撤销临时内容赠送（只移除该来源，基础订阅不受影响）。 */
export const revokeContentGrantSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  grantId: z.string().startsWith("content_grant:"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type RevokeContentGrant = z.infer<typeof revokeContentGrantSchema>;

/**
 * LCA13：内容交付修复。expectedCurrentRevision 是限定修订护栏——运营声明
 * 其看到的当前快照修订；不匹配即冲突（新版快照已出现，旧重试不得覆盖新撤权）。
 */
export const repairContentDeliverySchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
  expectedCurrentRevision: z.number().int().nonnegative().nullable(),
}).strict();

export type RepairContentDelivery = z.infer<typeof repairContentDeliverySchema>;

/** LCA13：工作区级授权投影事实（content_authorization_projection 行，懒投影）。 */
export type WorkspaceProjectionFact = {
  /** absent=尚无投影行（首次换票时才创建，不算故障）。 */
  state: "absent" | "active" | "closed" | "expired";
  revision: string | null;
  revisionNumber: number | null;
  /** 投影行与当前已交付快照比对（revisionNumber+digest）；absent 或无已交付快照时为 null。 */
  matchesExpected: boolean | null;
  confirmedUntil: string | null;
  expectedRevisionNumber: number | null;
};

/**
 * LCA13：内容投影核验（复用 content_projection_sync 同款受限会话，运营无额外权力）。
 * verdict 语义：ok=集合可读且已有投影行与当前快照一致；empty_collection=集合没有
 * 任何已发布条目（内容侧未供稿，不算系统交付失败）；license_blocked=集合有已发布
 * 条目但因来源停用/许可窗口/动作交集全部不可读；projection_stale=已有投影行与
 * 当前已交付快照不一致或已关闭/过期；projection_error=目录或投影事实异常（如
 * 已发布条目缺当前版本）；unavailable=核验会话不可用，无结论。
 */
export type ProjectionVerification = {
  checkedAt: string;
  verdict: "ok" | "empty_collection" | "license_blocked" | "projection_stale" | "projection_error" | "unavailable";
  workspace: WorkspaceProjectionFact;
  collections: {
    key: string;
    label: string;
    publishedItems: number;
    /** 按逐来源许可矩阵判定可读的条目数。 */
    readableItems: number;
    blockedItems: number;
    sources: {
      sourceId: string;
      sourceStatus: string;
      licenseFrom: string | null;
      licenseUntil: string | null;
      licenseActions: string[];
      items: number;
      valid: boolean;
      reason:
        | "version_missing"
        | "source_inactive"
        | "license_missing"
        | "license_not_started"
        | "license_expired"
        | "action_denied"
        | null;
    }[];
  }[];
};

/** LCA13：异常队列条目。正常到期与合法 over_limit 不属于系统失败，不入队。 */
export type EntitlementExceptionKind =
  | "delivery_pending"
  | "projection_failure"
  | "ai_settlement_anomaly";

export type EntitlementExceptionItem = {
  workspaceSlug: string;
  kinds: EntitlementExceptionKind[];
  detail: {
    /** delivery_pending：已确认商业来源绑定的修订与当前快照修订不一致。 */
    boundRevisionId: string | null;
    currentRevisionId: string | null;
    currentRevision: number | null;
    /** projection_failure：投影核验结论。 */
    projectionVerdict: ProjectionVerification["verdict"] | null;
    /** ai_settlement_anomaly：卡死预留数与说明。 */
    stuckReservations: number;
    anomalyNote: string | null;
  };
};

export type DeliveryRepairResult = {
  before: ProductEntitlementView;
  after: ProductEntitlementView;
  changed: boolean;
  /** 修复顺带重驱的 AI 周期额度指令（幂等同步，不新增授予语义）。 */
  planCycleSynced: boolean;
  note: string;
};

export type ProductEntitlementView = {
  workspaceSlug: string;
  revision: number;
  summary: string;
  resolverVersion: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  baseSource: {
    kind: "subscription" | "trial" | "none";
    sourceId: string | null;
    planKey: string | null;
    planName: string | null;
    planRevision: number | null;
  };
  content: {
    projectionStatus: "pending_delivery" | "none";
    projectionLabel: string;
    consumesAiAllowance: false;
    collections: { key: string; label: string }[];
    actions: string[];
    sources: {
      kind: "base" | "grant";
      sourceId: string;
      label: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      /** LCA13：赠送来源的解释性事实（仅 grant 来源，运营/客户视图均可读）。 */
      reason?: string | null;
      operatorSubject?: string | null;
      revoked?: boolean;
    }[];
    /** LCA13：内容投影核验结果（运营视图注入；客户视图为 null）。 */
    projection?: ProjectionVerification | null;
  };
  ai: {
    actions: string[];
    consumableAllowance: number | null;
    ledger: "unavailable" | "ok";
    ledgerLabel: string;
    /** LCA13：AI 预留/结算状态（运营视图注入真实账本事实；客户视图为 null）。 */
    reserved?: number | null;
    settled?: number | null;
    suspended?: number | null;
    terminated?: number | null;
    expired?: number | null;
    /** 超过结算窗口仍未终态的预留数（异常队列与运营解释共用）。 */
    stuckReservations?: number | null;
  };
  features: { key: string; enabled: boolean; limit: number | null }[];
  resource: {
    appliedPlanKey: string | null;
    appliedPlanName: string | null;
    appliedRevision: number | null;
    desiredPlanKey: string | null;
    syncState: string | null;
    status: "applied" | "pending" | "unknown";
    statusLabel: string;
  };
};
