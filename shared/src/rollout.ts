import { z } from "zod";

/**
 * LCA14 受控灰度开关：workspace 级「新法律内容访问」与「法律研究 AI」独立开关。
 *
 * 语义：缺省（无开关行）= enabled——开关是只收紧的运营覆盖层，不授予任何权益；
 * disable 永远允许（关停方向）；restore 要求目标 workspace 在至少一个 active
 * 批次的受控名单内（受控名单是唯一扩口凭据）。所有操作写不可变审计事件。
 */
export const ROLLOUT_GATES = ["legal_content_access", "legal_research_ai"] as const;
export type RolloutGateKey = (typeof ROLLOUT_GATES)[number];

export const ROLLOUT_GATE_LABELS: Record<RolloutGateKey, string> = {
  legal_content_access: "新法律内容访问（content-reader/content-search 换票与平台检索新会话）",
  legal_research_ai: "法律研究 AI（/api/chat 新研究与已暂停 run 的续跑）",
};

export type RolloutGateState = "enabled" | "disabled";
export const ROLLOUT_GATE_ACTIONS = ["disable", "restore"] as const;
export type RolloutGateAction = (typeof ROLLOUT_GATE_ACTIONS)[number];

export const ROLLOUT_BATCH_STATUSES = ["draft", "active", "closed"] as const;
export type RolloutBatchStatus = (typeof ROLLOUT_BATCH_STATUSES)[number];

export const ROLLOUT_OPERATION_KINDS = [
  "gate_disable",
  "gate_restore",
  "batch_register",
  "batch_activate",
  "batch_close",
] as const;
export type RolloutOperationKind = (typeof ROLLOUT_OPERATION_KINDS)[number];

const reasonSchema = z.string().trim().min(1).max(500);
const idempotencyKeySchema = z.string().min(8).max(200);
const workspaceSlugSchema = z.string().trim().min(1).max(128);
const batchKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);

/** 关闭 / 恢复单个 workspace 的单个开关。restore 由服务端校验受控名单，请求不携带名单。 */
export const setWorkspaceRolloutGateSchema = z.object({
  gate: z.enum(ROLLOUT_GATES),
  action: z.enum(ROLLOUT_GATE_ACTIONS),
  reason: reasonSchema,
  /** 可选：本次操作归属的批次名（记录用，不替代服务端名单校验）。 */
  batchKey: batchKeySchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();
export type SetWorkspaceRolloutGate = z.infer<typeof setWorkspaceRolloutGateSchema>;

const rolloutSourceSchema = z.object({
  sourceKey: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(200),
  /** 合法来源凭据/许可说明；公开网页不算可销售来源，须写明许可依据。 */
  licenseNote: z.string().trim().min(1).max(500),
}).strict();

const rolloutPlanMappingSchema = z.object({
  planKey: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  /** AI 费率说明（如每 run 预留口径）；未配置写 "未开放"。 */
  aiRate: z.string().trim().min(1).max(200),
  /** 试用额度；无试用额度为 null。 */
  trialAllowance: z.number().int().nonnegative().nullable(),
  /** 历史资源订阅映射说明（quota_plan_revision 等）；无映射写 "无"。 */
  legacySubscriptionMap: z.string().trim().min(1).max(500),
}).strict();

/** 具名灰度批次：一次受控发布的完整事实登记。缺项/未开放范围必须如实列入 gaps。 */
export const registerRolloutBatchSchema = z.object({
  batchKey: batchKeySchema,
  label: z.string().trim().min(1).max(200),
  /** 应用发布标识（git SHA / Deploy run id）。 */
  appRelease: z.string().trim().min(1).max(200),
  /** IdP 发布版本。 */
  idpRelease: z.string().trim().min(1).max(200),
  /** schema / 权益修订说明（system schema 版本、产品修订等）。 */
  schemaRevision: z.string().trim().min(1).max(300),
  legalSources: z.array(rolloutSourceSchema).max(64),
  planMapping: z.array(rolloutPlanMappingSchema).max(32),
  /** 受控名单：仅允许这些 workspace slug 被 restore；缺省不扩大客户开放范围。 */
  allowedWorkspaces: z.array(workspaceSlugSchema).min(1).max(64),
  /** 缺项与未开放范围；空数组 = 无缺口（须在 label/reason 可稽核）。 */
  gaps: z.array(z.string().trim().min(1).max(300)).max(64),
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export type RegisterRolloutBatch = z.infer<typeof registerRolloutBatchSchema>;

/** 批次流转：draft → active → closed（closed 终态）；draft 也可直接 close（作废草稿）。 */
export const updateRolloutBatchStatusSchema = z.object({
  status: z.enum(["active", "closed"]),
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export type UpdateRolloutBatchStatus = z.infer<typeof updateRolloutBatchStatusSchema>;

export type RolloutGateView = {
  gate: RolloutGateKey;
  label: string;
  state: RolloutGateState;
  /** 操作序位；0 = 从未被操作（默认 enabled）。 */
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
  batchKey: string | null;
};

export type RolloutOperationView = {
  id: string;
  kind: RolloutOperationKind;
  gate: RolloutGateKey | null;
  workspaceSlug: string | null;
  batchKey: string | null;
  actorSubject: string;
  capability: string;
  reason: string;
  beforeState: RolloutGateState | RolloutBatchStatus | null;
  afterState: RolloutGateState | RolloutBatchStatus | null;
  beforeRevision: number | null;
  afterRevision: number | null;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
};

export type RolloutBatchView = {
  batchKey: string;
  label: string;
  status: RolloutBatchStatus;
  appRelease: string;
  idpRelease: string;
  schemaRevision: string;
  legalSources: { sourceKey: string; label: string; licenseNote: string }[];
  planMapping: {
    planKey: string;
    displayName: string;
    aiRate: string;
    trialAllowance: number | null;
    legacySubscriptionMap: string;
  }[];
  allowedWorkspaces: string[];
  gaps: string[];
  reason: string;
  createdBy: string;
  createdAt: string;
  activatedBy: string | null;
  activatedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeReason: string | null;
};

/** 单个 workspace 的开关状态视图（运营/QA 查证用）。 */
export type WorkspaceRolloutStatus = {
  workspaceSlug: string;
  gates: RolloutGateView[];
  /** 覆盖本 workspace 的 active 批次名单。 */
  activeBatches: string[];
  recentOperations: RolloutOperationView[];
};
