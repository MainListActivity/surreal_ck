import { z } from "zod";
import type { AiChatMessage } from "./ai-context";
import type { CapabilityMatrix } from "./capabilities";

// Legacy desktop RPC shape placeholder. Web-only code should not add new
// Electrobun contracts, but historical DTOs still reference AppRPC.
type LegacyRPCSchema = Record<string, unknown>;

export type {
  CapabilityBlockedReason,
  CapabilityKey,
  CapabilityState,
} from "./capabilities";

// ─── 传输基础类型 ─────────────────────────────────────────────────────────────

/** SurrealDB record id serialized for transport, e.g. "workspace:abc123". */
export type RecordIdString = string;

/** ISO-8601 datetime string serialized for transport. */
export type ISODateTimeString = string;

// Legacy scaffold channel. Do not use for product APIs.
export type LegacyRowData = {
  id: string;
  name: string;
  value: string;
};

export type RawQueryRequest = {
  sql: string;
};

export type RawQueryResponse = unknown[];

export type AuthState = {
  loggedIn: boolean;
  expiresAt?: number;
  error?: string;
  offlineMode?: boolean;
};

// ─── 错误模型 ──────────────────────────────────────────────────────────────────

export type AppErrorCode =
  | "NOT_AUTHENTICATED"
  | "OFFLINE_READ_ONLY"
  | "NOT_IMPLEMENTED"
  | "BOOTSTRAP_REQUIRED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "SQL_MUTATION_WARNING"
  | "OFFLINE_DDL_FORBIDDEN"
  | "REMOTE_DDL_FAILED"
  | "TEMPLATE_REJECTED";

export type AppError = {
  ok: false;
  code: AppErrorCode;
  message: string;
};

export type AppOk<T> = {
  ok: true;
  data: T;
};

export type Result<T> = AppOk<T> | AppError;

// ─── 业务 DTO ─────────────────────────────────────────────────────────────────

export type CurrentUserDTO = {
  id: RecordIdString;
  subject: string;
  email?: string;
  name?: string;
  displayName?: string;
  avatar?: string;
};

export type WorkspaceDTO = {
  id: RecordIdString;
  name: string;
  slug: string;
};

export type CapabilityMatrixDTO = CapabilityMatrix;

export type AppBootstrap = {
  auth: AuthState;
  capabilities: CapabilityMatrixDTO;
  user?: CurrentUserDTO;
  defaultWorkspace?: WorkspaceDTO;
};

/**
 * 同步状态 v2 — 反映 "重建 + LIVE" 架构下的本地派生状态健康。
 * 取代旧双向 replay 主状态模型（参见 ADR sync §4 / §12）。
 */
export type SyncStatusV2DTO = {
  online: boolean;
  rebuildInProgress: boolean;
  dirtyStructureShadow: boolean;
  dirtyProjectionData: boolean;
  incompatibleSchema: boolean;
  lastRebuildAt?: ISODateTimeString;
  lastError?: string;
  /** refresh_token 已失效，自动重连已停止，需用户重新登录。 */
  needsRelogin?: boolean;
  /** 主进程正在执行一次 reconnect。 */
  reconnecting?: boolean;
  /** 下一次自动重连的绝对时间（ms since epoch）。未排程时缺省。 */
  nextRetryAt?: number;
};

export type ReconnectRemoteResponse = {
  status: "reconnected" | "offline" | "needs-relogin";
  message?: string;
  sync: SyncStatusV2DTO;
};

export type ObservabilitySettingsDTO = {
  retentionDays: number;
};

export type AiProvider = "openai" | "anthropic" | "google" | "custom";
export type AiApiFormat = "openai-compatible" | "openai-responses" | "anthropic";

export type AiSettingsDTO = {
  provider: AiProvider;
  model: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  secretConfigured: boolean;
};

export type EmbeddingSettingsDTO = {
  provider: AiProvider;
  model: string;
  dimensions: number;
  version: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  secretConfigured: boolean;
};

export type SaveAiSettingsDTO = {
  provider: AiProvider;
  model: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type SaveEmbeddingSettingsDTO = {
  provider: AiProvider;
  model: string;
  dimensions: number;
  version: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  apiKey?: string;
  clearApiKey?: boolean;
};

export type GetSettingsResponse = {
  observability: ObservabilitySettingsDTO;
  ai: AiSettingsDTO;
  embedding: EmbeddingSettingsDTO;
};

export type SaveSettingsRequest = {
  observability: ObservabilitySettingsDTO;
  ai: SaveAiSettingsDTO;
  embedding?: SaveEmbeddingSettingsDTO;
};

export type SaveSettingsResponse = GetSettingsResponse;

export type SendAiMessageRequest = {
  message: AiChatMessage;
  /** 由前端生成的本次流式会话 id；后续 aiMessageChunk 通过该 id 回填到 placeholder 消息上。 */
  streamId: string;
  /** AI 输入区的显式提交模式；resource-search 会确定性进入资源检索子 agent。 */
  composerMode?: "chat" | "resource-search";
  /** 本次对话的历史消息（不含当前 message），用于给 agent 提供多轮上下文。 */
  history?: AiChatMessage[];
};

export type SendAiMessageResponse = {
  message: AiChatMessage;
  toolCalls: Array<{
    toolName: string;
    args?: unknown;
    result?: unknown;
  }>;
  /** 本次 agent 运行的稳定 id；issue 011/012 resume 时使用。 */
  runId: string;
};

// ─── AI RPC Zod Schemas ──────────────────────────────────────────────────────

const AiRouteContextSchema = z.object({
  screen: z.string(),
  dashboardPageId: z.string().optional(),
  workbookId: z.string().optional(),
  sheetId: z.string().optional(),
  folderId: z.string().optional(),
  templateKey: z.string().optional(),
});

const AiWorkbookContextSchema = z.object({ id: z.string(), name: z.string() }).nullable();
const AiSheetContextSchema = z.object({ id: z.string(), label: z.string(), tableName: z.string() }).nullable();
const AiSelectedRowContextSchema = z.object({ id: z.string(), label: z.string(), visibleValues: z.record(z.string(), z.unknown()) }).nullable();

const AiContextSnapshotSchema = z.object({
  route: AiRouteContextSchema,
  workbook: AiWorkbookContextSchema,
  sheet: AiSheetContextSchema,
  selectedRow: AiSelectedRowContextSchema,
  contextHint: z.string(),
});

const AiChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  context: AiContextSnapshotSchema,
});

export const SendAiMessageRequestSchema = z.object({
  message: AiChatMessageSchema,
  streamId: z.string(),
  composerMode: z.enum(["chat", "resource-search"]).optional(),
  history: z.array(AiChatMessageSchema).optional(),
});

export const SendAiMessageResponseSchema = z.object({
  message: AiChatMessageSchema,
  toolCalls: z.array(
    z.object({
      toolName: z.string(),
      args: z.unknown().optional(),
      result: z.unknown().optional(),
    }),
  ),
  runId: z.string(),
});

// ─── AI executeAction 类型定义 + Zod Schema ───────────────────────────────────

export type AppNavigationIntent = {
  type: "navigate";
  screen: string;
  workbookId?: string;
  sheetId?: string;
  dashboardPageId?: string;
};

export type ToolNavigationIntent =
  | { type: "navigate"; route: string }
  | { type: "open-workbook"; workbookId: string; label?: string }
  | { type: "open-dashboard"; dashboardId: string; label?: string }
  | { type: "open-record"; workbookId: string; sheetId: string; recordId: string; label?: string }
  | { type: "ambiguous"; candidates: {
    label: string;
    id: string;
    summary?: string;
    score?: number;
    resourceType?: string;
    sourceUrl?: string;
  }[] };

export type DashboardDraftIntent = {
  type: "dashboard-draft";
  title: string;
  description: string;
  widgetSpec: DashboardBuilderSpec;
  draft: DashboardViewDraftDTO;
  explanation: string;
  preview?: DashboardPreviewResponse;
};

export type LegacyDashboardDraftIntent = {
  type: "dashboardDraft";
  draft: Record<string, unknown>;
};

export type RowPatchProposal = {
  type: "row-patch-proposal";
  sheetId: string;
  recordId: string;
  proposals: Array<{
    field: string;
    currentValue: unknown;
    suggestedValue: unknown;
    basis: string;
    confidence: "high" | "medium" | "low";
  }>;
};

export type RowPatchIntent = {
  type: "rowPatch";
  sheetId: string;
  rowId: string;
  patch: Record<string, unknown>;
};

export type ResourceCitationDTO = {
  index: number;
  resourceId: RecordIdString;
  title: string;
  sourceUrl?: string;
  evidence?: Array<{
    order: number;
    text: string;
  }>;
};

export type ResourceDraftIntent = {
  type: "resource-draft";
  draft: SaveResourceRequest;
  explanation?: string;
  citations?: ResourceCitationDTO[];
};

export type AiStructuredIntent =
  | AppNavigationIntent
  | ToolNavigationIntent
  | DashboardDraftIntent
  | LegacyDashboardDraftIntent
  | RowPatchProposal
  | RowPatchIntent
  | ResourceDraftIntent;

export type ExecuteAiActionRequest = {
  intent: AiStructuredIntent;
  /** 写操作时附带，便于 ai.executeAction 在写动作成功后清理对应 workflow run 快照（issue 012）。 */
  runId?: string;
  workflowName?: string;
};

export type ExecuteAiActionResponse = {
  ok: boolean;
  message?: string;
  navigation?: AppNavigationIntent;
};

const AppNavigationIntentSchema = z.object({
  type: z.literal("navigate"),
  screen: z.string(),
  workbookId: z.string().optional(),
  sheetId: z.string().optional(),
  dashboardPageId: z.string().optional(),
});

const ToolNavigationIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    route: z.string(),
  }),
  z.object({
    type: z.literal("open-workbook"),
    workbookId: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("open-dashboard"),
    dashboardId: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("open-record"),
    workbookId: z.string(),
    sheetId: z.string(),
    recordId: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("ambiguous"),
    candidates: z.array(z.object({
      label: z.string(),
      id: z.string(),
      summary: z.string().optional(),
      score: z.number().optional(),
      resourceType: z.string().optional(),
      sourceUrl: z.string().optional(),
    })),
  }),
]);

const DashboardBuilderMetricSchema = z.object({
  op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
  field: z.string().optional(),
});

const DashboardBuilderSpecSchema = z.object({
  sourceTables: z.array(z.string()),
  baseTable: z.string(),
  metric: DashboardBuilderMetricSchema,
  dimensions: z.array(z.object({
    field: z.string(),
    bucket: z.enum(["day", "week", "month", "year"]).optional(),
  })).optional(),
  filters: z.array(z.object({
    field: z.string(),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "is_not_null"]),
    value: z.unknown().optional(),
  })).optional(),
  sort: z.object({
    field: z.string(),
    direction: z.enum(["asc", "desc"]),
  }).optional(),
  limit: z.number().optional(),
});

const DashboardViewDraftSchema = z.object({
  workspaceId: z.string(),
  workbookId: z.string().optional(),
  title: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  queryMode: z.enum(["preset", "builder", "sql"]),
  viewType: z.enum(["kpi", "table", "bar", "line", "pie", "area"]),
  resultContract: z.enum(["single_value", "category_breakdown", "time_series", "table_rows"]),
  compiledSql: z.string().optional(),
  builderSpec: DashboardBuilderSpecSchema.optional(),
  displaySpec: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["draft", "active", "invalid"]).optional(),
});

const DashboardDraftIntentSchema = z.object({
  type: z.literal("dashboard-draft"),
  title: z.string(),
  description: z.string(),
  widgetSpec: DashboardBuilderSpecSchema,
  draft: DashboardViewDraftSchema,
  explanation: z.string(),
  preview: z.unknown().optional(),
});

const LegacyDashboardDraftIntentSchema = z.object({
  type: z.literal("dashboardDraft"),
  draft: z.record(z.string(), z.unknown()),
});

const RowPatchProposalSchema = z.object({
  type: z.literal("row-patch-proposal"),
  sheetId: z.string(),
  recordId: z.string(),
  proposals: z.array(z.object({
    field: z.string(),
    currentValue: z.unknown(),
    suggestedValue: z.unknown(),
    basis: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const RowPatchIntentSchema = z.object({
  type: z.literal("rowPatch"),
  sheetId: z.string(),
  rowId: z.string(),
  patch: z.record(z.string(), z.unknown()),
});

const ResourceCitationSchema = z.object({
  index: z.number().int().positive(),
  resourceId: z.string(),
  title: z.string(),
  sourceUrl: z.string().optional(),
  evidence: z.array(z.object({
    order: z.number().int().nonnegative(),
    text: z.string(),
  })).optional(),
});

const ResourceDraftIntentSchema = z.object({
  type: z.literal("resource-draft"),
  draft: z.object({
    workspaceId: z.string(),
    resourceType: z.string(),
    title: z.string(),
    summary: z.string(),
    sourceUrl: z.string().optional(),
    sourceTitle: z.string().optional(),
    evidence: z.array(z.object({
      text: z.string(),
      sourceUrl: z.string().optional(),
      sourceTitle: z.string().optional(),
      capturedAt: z.string(),
      order: z.number().int().nonnegative(),
    })),
    tags: z.array(z.string()).optional(),
    structuredPayload: z.record(z.string(), z.unknown()).optional(),
    quality: z.enum(["user-confirmed", "ai-draft", "imported", "deprecated"]),
    confidence: z.number().optional(),
    sourceTrust: z.string().optional(),
    researchSessionId: z.string().optional(),
  }),
  explanation: z.string().optional(),
  citations: z.array(ResourceCitationSchema).optional(),
});

export const AiStructuredIntentSchema = z.union([
  AppNavigationIntentSchema,
  ...ToolNavigationIntentSchema.options,
  DashboardDraftIntentSchema,
  LegacyDashboardDraftIntentSchema,
  RowPatchProposalSchema,
  RowPatchIntentSchema,
  ResourceDraftIntentSchema,
]);

export const ExecuteAiActionRequestSchema = z.object({
  intent: AiStructuredIntentSchema,
  runId: z.string().optional(),
  workflowName: z.string().optional(),
});

export const ExecuteAiActionResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  navigation: AppNavigationIntentSchema.optional(),
});

export type AiToolCallRecord = {
  toolName: string;
  args?: unknown;
  result?: unknown;
};

/** 主进程推送给 webview 的流式增量；与 SendAiMessageRequest.streamId 配对。 */
export type AiMessageChunkEvent =
  | { streamId: string; type: "delta"; text: string }
  | { streamId: string; type: "error"; message: string }
  | { streamId: string; type: "done"; message: AiChatMessage; toolCalls: AiToolCallRecord[] };

// ─── ai.progressStream 进度事件 ──────────────────────────────────────────────
//
// 主进程在 agent 执行过程中向 renderer 推送的进度事件。所有事件以 runId 关联到
// 一次 ai.chat 调用的 SendAiMessageResponse.runId。
//
// V1（issue 003）只发 "tool-call"；"routing" / "agent-step" 是为 Router workflow
// （issue 011 / 012）预留的事件 kind，schema 必须前向兼容。

export type AiProgressEvent =
  | { kind: "routing"; runId: string }
  | { kind: "agent-step"; runId: string; agentName: string; taskText: string }
  | { kind: "tool-call"; runId: string; toolId: string };

export const AiProgressEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("routing"), runId: z.string() }),
  z.object({
    kind: z.literal("agent-step"),
    runId: z.string(),
    agentName: z.string(),
    taskText: z.string(),
  }),
  z.object({ kind: z.literal("tool-call"), runId: z.string(), toolId: z.string() }),
]);

export type AiRunCancelledEvent = {
  runId: string;
  sessionId?: string;
  reason: "user-cancelled" | "research-window-closed";
  message: string;
};

export const AiRunCancelledEventSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  reason: z.enum(["user-cancelled", "research-window-closed"]),
  message: z.string().min(1),
});

// ─── Workflow suspend / resume（issue 012） ──────────────────────────────────
//
// router workflow 在 ambiguous 候选 / 写操作前需要暂停等待用户决策。
// 暂停时主进程通过 webview.messages.aiSuspended 把 payload 推给 AI 抽屉；
// 用户选择后通过 ai.resumeAiWorkflow request 触达，主进程拉起对应 run.resume()。

export const ResolvedRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type ResolvedRecord = z.infer<typeof ResolvedRecordSchema>;

export type CandidateOption = {
  id: string;
  label: string;
  summary?: string;
  score?: number;
  resourceType?: string;
  sourceUrl?: string;
};

const CandidateOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().optional(),
  score: z.number().optional(),
  resourceType: z.string().optional(),
  sourceUrl: z.string().optional(),
});

const AmbiguousCandidatesEventSchema = z.object({
  kind: z.literal("ambiguous-candidates"),
  runId: z.string(),
  candidates: z.array(CandidateOptionSchema),
  truncated: z.boolean().optional(),
});

const ResourceCandidatesEventSchema = z.object({
  kind: z.literal("resource-candidates"),
  runId: z.string(),
  candidates: z.array(CandidateOptionSchema),
  truncated: z.boolean().optional(),
});

const ManualResearchEventSchema = z.object({
  kind: z.literal("manual-research"),
  runId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  query: z.string(),
  resourceType: z.string(),
});

const AwaitWriteConfirmEventSchema = z.object({
  kind: z.literal("await-write-confirm"),
  runId: z.string(),
  intent: AiStructuredIntentSchema,
});

export const WorkflowSuspendedEventSchema = z.discriminatedUnion("kind", [
  AmbiguousCandidatesEventSchema,
  ResourceCandidatesEventSchema,
  ManualResearchEventSchema,
  AwaitWriteConfirmEventSchema,
]);
export type WorkflowSuspendedEvent = z.infer<typeof WorkflowSuspendedEventSchema>;

const ResumeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate-chosen"), candidateId: z.string().min(1) }),
  z.object({ kind: z.literal("candidate-cancelled") }),
  z.object({ kind: z.literal("write-confirmed") }),
  z.object({ kind: z.literal("write-rejected") }),
  z.object({ kind: z.literal("resource-candidates-chosen"), resourceIds: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("resource-candidates-manual-research") }),
  z.object({ kind: z.literal("manual-research-completed"), resourceIds: z.array(z.string().min(1)).min(1) }),
]);
export type ResumeDecision = z.infer<typeof ResumeDecisionSchema>;

export const ResumeAiWorkflowRequestSchema = z.object({
  runId: z.string().min(1),
  decision: ResumeDecisionSchema,
  /** 可选：默认 routerWorkflow */
  workflowName: z.string().optional(),
});
export type ResumeAiWorkflowRequest = z.infer<typeof ResumeAiWorkflowRequestSchema>;

export type ResumeAiWorkflowResponse = {
  resumed: boolean;
  /** 若 resume 完成（success 或再次 suspended）则附带最终文本；用户取消时 resumed=false。 */
  finalText?: string;
  status: "success" | "suspended" | "cancelled";
};

export const CancelAiWorkflowRequestSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  reason: z.enum(["user-cancelled", "research-window-closed"]).optional(),
});
export type CancelAiWorkflowRequest = z.infer<typeof CancelAiWorkflowRequestSchema>;

export type CancelAiWorkflowResponse = {
  cancelled: boolean;
  event: AiRunCancelledEvent;
};

export type WorkbookSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  name: string;
  templateKey?: string;
  folderId?: RecordIdString;
  updatedAt?: ISODateTimeString;
};

export type ListWorkbooksRequest = {
  workspaceId: RecordIdString;
  folderId?: RecordIdString | null;
  search?: string;
};

export type ListWorkbooksResponse = {
  workbooks: WorkbookSummaryDTO[];
};

export type CreateBlankWorkbookRequest = {
  workspaceId: RecordIdString;
  name: string;
  folderId?: RecordIdString | null;
};

export type CreateBlankWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

export type FolderDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  name: string;
  parentId?: RecordIdString;
  position: number;
};

export type ListFoldersRequest = {
  workspaceId: RecordIdString;
};

export type ListFoldersResponse = {
  folders: FolderDTO[];
};

export type CreateFolderRequest = {
  workspaceId: RecordIdString;
  name: string;
  parentId?: RecordIdString;
};

export type CreateFolderResponse = {
  folder: FolderDTO;
};

export type MoveFolderRequest = {
  folderId: RecordIdString;
  /** 新的父目录 id；null 表示移到根目录 */
  parentId: RecordIdString | null;
};

export type MoveFolderResponse = {
  folder: FolderDTO;
};

export type MoveWorkbookRequest = {
  workbookId: RecordIdString;
  /** 新的目录 id；null 表示移出目录（未分类） */
  folderId: RecordIdString | null;
};

export type MoveWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

// ─── Template DTOs ────────────────────────────────────────────────────────────

export type TemplateSummaryDTO = {
  key: string;
  name: string;
  description: string;
  tags: string[];
};

export type ListTemplatesResponse = {
  templates: TemplateSummaryDTO[];
};

export type CreateWorkbookFromTemplateRequest = {
  workspaceId: RecordIdString;
  templateKey: string;
  name?: string;
};

export type CreateWorkbookFromTemplateResponse = {
  workbook: WorkbookSummaryDTO;
};

// ─── Editor DTOs ──────────────────────────────────────────────────────────────

export type GridFieldConstraints = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  minDate?: ISODateTimeString;
  maxDate?: ISODateTimeString;
};

export type GridColumnDef = {
  key: string;
  label: string;
  fieldType: string;
  required?: boolean;
  options?: string[];
  constraints?: GridFieldConstraints;
  /** 仅 fieldType === "date" 有效；dayjs 格式串，例如 "YYYY-MM-DD HH:mm:ss"。 */
  dateFormat?: string;
  /** 仅 fieldType === "reference" 有效。目标表名：app_user 或 ent_xxx。建表后不可更换。 */
  referenceTable?: string;
  /** 仅 fieldType === "reference" 且目标为 sheet 时有意义；缓存目标 sheet.id 以便 UI 反查。 */
  referenceSheetId?: RecordIdString;
  /** 仅 fieldType === "reference" 有效。允许多选；默认为 false。 */
  referenceMultiple?: boolean;
  /** 仅 fieldType === "reference" 有效。展示用字段 key；缺省回退到 name → display_name → email → id。 */
  referenceDisplayKey?: string;
};

/** 单个筛选条件。op 决定 value 是否使用、以及如何使用。 */
export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type FilterClause = {
  key: string;
  op: FilterOp;
  /** 对 in：数组；对 contains/eq/...：标量；对 is_null/is_not_null：忽略 */
  value?: unknown;
};

export type SortClause = {
  key: string;
  direction: "asc" | "desc";
};

/** Sheet 视图的查询参数。所有过滤/排序在数据库执行；隐藏与分组在前端展示层。 */
export type ViewParams = {
  filters?: FilterClause[];
  /** 多条件 AND/OR；默认 AND */
  filterMode?: "and" | "or";
  sorts?: SortClause[];
  hiddenFields?: string[];
  groupBy?: string | null;
};

export type GridRow = {
  id: RecordIdString;
  values: Record<string, unknown>;
};

export type SheetSummaryDTO = {
  id: RecordIdString;
  workbookId: RecordIdString;
  univerId: string;
  tableName: string;
  label: string;
  position: number;
  columnDefs: GridColumnDef[];
};

export type WorkbookDataDTO = {
  workbook: WorkbookSummaryDTO;
  sheets: SheetSummaryDTO[];
  activeSheetId: RecordIdString;
  columns: GridColumnDef[];
  rows: GridRow[];
};

export type GetWorkbookDataRequest = {
  workbookId: RecordIdString;
  sheetId?: RecordIdString;
  viewParams?: ViewParams;
};

export type GetWorkbookDataResponse = WorkbookDataDTO;

export type UpsertRowsRequest = {
  sheetId: RecordIdString;
  rows: Array<{ id?: RecordIdString; values: Record<string, unknown> }>;
};

export type UpsertRowsResponse = {
  upserted: GridRow[];
};

export type DeleteRowsRequest = {
  sheetId: RecordIdString;
  ids: RecordIdString[];
};

export type DeleteRowsResponse = {
  deleted: number;
};

export type RenameWorkbookRequest = {
  workbookId: RecordIdString;
  name: string;
};

export type RenameWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

export type UpdateSheetFieldsRequest = {
  sheetId: RecordIdString;
  columns: GridColumnDef[];
};

export type UpdateSheetFieldsResponse = {
  sheet: SheetSummaryDTO;
  columns: GridColumnDef[];
};

export type CreateSheetRequest = {
  workbookId: RecordIdString;
  /** 可选：用户指定的 sheet 名称，缺省时后端按 "Sheet N" 自动生成 */
  label?: string;
};

export type CreateSheetResponse = {
  sheet: SheetSummaryDTO;
};

export type RenameSheetRequest = {
  sheetId: RecordIdString;
  label: string;
};

export type RenameSheetResponse = {
  sheet: SheetSummaryDTO;
};

// ─── Reference DTOs ──────────────────────────────────────────────────────────

/** 一条被引用记录在 UI 中的展示快照（单元格徽章 / 悬停浮窗 / 详情侧栏共用）。 */
export type ReferenceTargetPreview = {
  id: RecordIdString;
  /** "app_user" 或 "ent_xxx"。 */
  table: string;
  /** 仅当 table 是 ent_* 时存在。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 单元格主显示文本，例如 "name 字段值" 或 "Sheet 名 / 主键 id"。 */
  primaryLabel: string;
  /** 当被引用记录已被删除时为 true，UI 渲染为「已删除的记录」。 */
  missing?: boolean;
  /** 浮窗用前 4–6 个字段值；不展示 id / workspace / created_* / updated_* 等系统字段。 */
  preview: Array<{ key: string; label: string; value: unknown }>;
};

export type ResolveReferencesRequest = {
  ids: RecordIdString[];
};

export type ResolveReferencesResponse = {
  items: ReferenceTargetPreview[];
};

export type ReferenceTargetOption = {
  /** 目标表名。 */
  table: string;
  /** UI 用的显示名，例如 "工作簿名 / Sheet 名" 或 "系统：用户"。 */
  label: string;
  /** 仅当 table 是 ent_* 时存在；用于 UI 树状分组与缓存。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 列出可用作展示字段的列：[{key,label,fieldType}] */
  displayKeys: Array<{ key: string; label: string; fieldType: string }>;
};

export type ListReferenceTargetsResponse = {
  /** 当前用户可访问的所有 sheet + 系统对象。允许跨 workspace。 */
  targets: ReferenceTargetOption[];
};

export type SearchReferenceCandidatesRequest = {
  /** 目标表名：app_user 或 ent_*。 */
  table: string;
  /** 模糊匹配关键词；空串表示返回前 N 条。 */
  query?: string;
  /** 用于决定按哪个字段拼 primaryLabel；缺省回退到 name / display_name / email / id。 */
  displayKey?: string;
  limit?: number;
};

export type SearchReferenceCandidatesResponse = {
  items: ReferenceTargetPreview[];
};

// ─── Table schema introspection ──────────────────────────────────────────────

/** 给仪表盘 builder 使用的字段元数据。统一用于业务表(ent_*)和系统表。 */
export type TableSchemaField = {
  /** 字段名。 */
  key: string;
  /** UI 展示名。业务表来自 column_defs.label；系统表用人工映射。 */
  label: string;
  /** 归一化字段类型：text/number/currency/date/boolean/reference/select/json/unknown。 */
  fieldType: string;
  /** 是否可空（来自 surreal 的 option<...> 推断或 column_defs.required）。 */
  nullable?: boolean;
  /** 仅当字段是 reference 时存在；目标表名。 */
  referenceTable?: string;
};

export type GetTableSchemaRequest = {
  table: string;
};

export type GetTableSchemaResponse = {
  table: string;
  /** "system" 表示从 INFO FOR TABLE 解析；"entity" 表示从 sheet.column_defs 读取。 */
  origin: "system" | "entity";
  fields: TableSchemaField[];
};

// ─── Resource retrieval DTOs ────────────────────────────────────────────────

export type ResourceQuality = "user-confirmed" | "ai-draft" | "imported" | "deprecated";
export type ResearchSessionStatus = "open" | "completed" | "cancelled";

export type ResourceEvidenceDTO = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
  capturedAt: ISODateTimeString;
  order: number;
};

export type ResourceDuplicateHashesDTO = {
  content: string;
  evidence: string;
  source: string;
};

export type ResourceEmbeddingStatus = "disabled" | "pending" | "indexed" | "failed" | "stale";

export type ResourceEmbeddingDTO = {
  status: ResourceEmbeddingStatus;
  profileKey?: string;
  provider?: string;
  model?: string;
  dimensions?: number;
  version?: string;
  errorSummary?: string;
  indexedAt?: ISODateTimeString;
  updatedAt?: ISODateTimeString;
};

export type ResourceDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidenceDTO[];
  tags: string[];
  structuredPayload: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  duplicateHashes: ResourceDuplicateHashesDTO;
  embedding: ResourceEmbeddingDTO;
  researchSessionId?: RecordIdString;
  createdBy: RecordIdString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
};

export type ResearchSessionDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  originatingRunId?: string;
  query: string;
  context: Record<string, unknown>;
  resourceType: string;
  status: ResearchSessionStatus;
  resourceIds: RecordIdString[];
  createdBy: RecordIdString;
  createdAt: ISODateTimeString;
  updatedAt: ISODateTimeString;
  completedAt?: ISODateTimeString;
  cancelledAt?: ISODateTimeString;
};

export type SaveResourceRequest = {
  workspaceId: RecordIdString;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidenceDTO[];
  tags?: string[];
  structuredPayload?: Record<string, unknown>;
  quality: ResourceQuality;
  confidence?: number;
  sourceTrust?: string;
  researchSessionId?: RecordIdString;
};

export type SaveResourceResponse = {
  resource: ResourceDTO;
};

export type SaveResearchResourceRequest = Omit<
  SaveResourceRequest,
  "workspaceId" | "resourceType" | "researchSessionId"
> & {
  sessionId: RecordIdString;
  resourceType?: string;
};

export type GetResourceDetailRequest = {
  resourceId: RecordIdString;
};

export type ResourceDetailResponse = {
  resource: ResourceDTO;
  session?: {
    id: RecordIdString;
    status: ResearchSessionStatus;
    query: string;
    resourceIds: RecordIdString[];
  };
};

export type ResourceSearchContext = {
  selectedRow?: {
    id?: string;
    label?: string;
    visibleValues?: Record<string, unknown>;
  } | Record<string, unknown>;
  document?: {
    title?: string;
    text?: string;
  } | string;
  manualText?: string;
};

export type ResourceSearchFilters = {
  tags?: string[];
  sourceDomain?: string;
  dateFrom?: ISODateTimeString;
  dateTo?: ISODateTimeString;
};

export type ResourceSearchStatus = "hit" | "candidates" | "miss";
export type ResourceSearchIndexStatus = "ready" | "index-disabled" | "index-pending" | "index-error";

export type SearchResourcesRequest = {
  workspaceId: RecordIdString;
  query: string;
  context?: ResourceSearchContext;
  resourceType?: string;
  filters?: ResourceSearchFilters;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
};

export type ResourceSearchResultDTO = {
  resource: ResourceDTO;
  score: number;
  vectorScore: number;
  keywordScore: number;
  qualityScore: number;
  recencyScore: number;
};

export type SearchResourcesResponse = {
  status: ResourceSearchStatus;
  indexStatus: ResourceSearchIndexStatus;
  queryText: string;
  results: ResourceSearchResultDTO[];
};

export type CreateResearchSessionRequest = {
  workspaceId: RecordIdString;
  query: string;
  context?: Record<string, unknown>;
  resourceType: string;
  originatingRunId?: string;
};

export type GetResearchSessionRequest = {
  sessionId: RecordIdString;
};

export type CompleteResearchSessionRequest = {
  sessionId: RecordIdString;
  resourceIds?: RecordIdString[];
};

export type CancelResearchSessionRequest = {
  sessionId: RecordIdString;
};

export type RetryResourceEmbeddingRequest = {
  resourceId: RecordIdString;
};

export type RetryResourceEmbeddingResponse = {
  embedding: ResourceEmbeddingDTO;
};

export type ResearchSessionResponse = {
  session: ResearchSessionDTO;
};

export type OpenResearchWindowRequest = {
  sessionId?: RecordIdString;
  initialUrl?: string;
  resourceType?: string;
};

export type OpenResearchWindowResponse = {
  opened: boolean;
  session?: ResearchSessionDTO;
};

export type GenerateResourceDraftRequest = {
  workspaceId: RecordIdString;
  resourceType: string;
  evidence: ResourceEvidenceDTO[];
  title?: string;
  summary?: string;
};

export type GenerateResourceDraftResponse = {
  draft: SaveResourceRequest;
};

// ─── Dashboard DTOs ──────────────────────────────────────────────────────────

export type DashboardQueryMode = "preset" | "builder" | "sql";
export type DashboardViewType = "kpi" | "table" | "bar" | "line" | "pie" | "area";
export type DashboardResultContract =
  | "single_value"
  | "category_breakdown"
  | "time_series"
  | "table_rows";
export type DashboardViewStatus = "draft" | "active" | "invalid";
export type DashboardCacheStatus = "ok" | "error" | "stale" | "running";
export type DashboardRefreshPolicy = "manual" | "on_open_if_stale" | "interval";

export type DashboardWidgetLayoutDTO = {
  id: string;
  viewId: RecordIdString;
  titleOverride?: string;
  grid: { x: number; y: number; w: number; h: number };
  displayOverride?: Record<string, unknown>;
  refreshPolicyOverride?: "inherit" | DashboardRefreshPolicy;
};

export type DashboardPageSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug: string;
  description?: string;
  updatedAt?: ISODateTimeString;
};

export type DashboardPageDTO = DashboardPageSummaryDTO & {
  widgets: DashboardWidgetLayoutDTO[];
};

export type DashboardBuilderMetricOp =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max";

export type DashboardBuilderFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type DashboardBuilderSpec = {
  sourceTables: string[];
  baseTable: string;
  metric: {
    op: DashboardBuilderMetricOp;
    field?: string;
  };
  dimensions?: Array<{
    field: string;
    bucket?: "day" | "week" | "month" | "year";
  }>;
  filters?: Array<{
    field: string;
    op: DashboardBuilderFilterOp;
    value?: unknown;
  }>;
  sort?: {
    field: string;
    direction: "asc" | "desc";
  };
  limit?: number;
};

export type DashboardViewSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  status: DashboardViewStatus;
  updatedAt?: ISODateTimeString;
  lastRunAt?: ISODateTimeString;
};

export type DashboardViewDTO = DashboardViewSummaryDTO & {
  compiledSql: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  sourceTables: string[];
  dependencies: string[];
  version: number;
  createdBy?: RecordIdString;
};

export type DashboardSingleValueResult = {
  value: number | string | boolean | null;
  label?: string;
  unit?: string;
  delta?: number | null;
};

export type DashboardCategoryBreakdownResult = {
  rows: Array<{ key: string; label: string; value: number }>;
};

export type DashboardTimeSeriesResult = {
  rows: Array<{ x: string; y: number; series?: string }>;
};

export type DashboardTableRowsResult = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
};

export type DashboardNormalizedResult =
  | DashboardSingleValueResult
  | DashboardCategoryBreakdownResult
  | DashboardTimeSeriesResult
  | DashboardTableRowsResult;

export type DashboardCacheDTO = {
  viewId: RecordIdString;
  status: DashboardCacheStatus;
  rowsCount: number;
  durationMs: number;
  executedAt?: ISODateTimeString;
  sqlHash: string;
  result?: DashboardNormalizedResult;
  resultMeta?: Record<string, unknown>;
  errorDetail?: unknown;
};

export type DashboardViewDraftDTO = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug?: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  compiledSql?: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  status?: DashboardViewStatus;
};

export type DashboardPreviewResponse = {
  sql: string;
  sourceTables: string[];
  dependencies: string[];
  durationMs: number;
  rowsCount: number;
  result: DashboardNormalizedResult;
  resultMeta: Record<string, unknown>;
  sqlHash: string;
};

export type ListDashboardPagesRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
};

export type ListDashboardPagesResponse = {
  pages: DashboardPageSummaryDTO[];
};

export type GetDashboardPageRequest = {
  pageId: RecordIdString;
};

export type GetDashboardPageResponse = {
  page: DashboardPageDTO;
  views: DashboardViewDTO[];
  caches: DashboardCacheDTO[];
};

export type CreateDashboardPageRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  description?: string;
};

export type CreateDashboardPageResponse = {
  page: DashboardPageDTO;
};

export type RenameDashboardPageRequest = {
  pageId: RecordIdString;
  title: string;
};

export type RenameDashboardPageResponse = {
  page: DashboardPageDTO;
};

export type SaveDashboardPageLayoutRequest = {
  pageId: RecordIdString;
  widgets: DashboardWidgetLayoutDTO[];
};

export type SaveDashboardPageLayoutResponse = {
  page: DashboardPageDTO;
};

export type ListDashboardViewsRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
};

export type ListDashboardViewsResponse = {
  views: DashboardViewSummaryDTO[];
};

export type CreateDashboardViewRequest = {
  draft: DashboardViewDraftDTO;
  confirmRisk?: boolean;
};

export type CreateDashboardViewResponse = {
  view: DashboardViewDTO;
  cache?: DashboardCacheDTO;
};

export type UpdateDashboardViewRequest = {
  viewId: RecordIdString;
  draft: DashboardViewDraftDTO;
  confirmRisk?: boolean;
};

export type UpdateDashboardViewResponse = {
  view: DashboardViewDTO;
  cache?: DashboardCacheDTO;
};

export type PreviewDashboardViewRequest = {
  draft: DashboardViewDraftDTO;
  confirmRisk?: boolean;
};

export type PreviewDashboardViewResponse = DashboardPreviewResponse;

export type RefreshDashboardViewRequest = {
  viewId: RecordIdString;
};

export type RefreshDashboardViewResponse = {
  cache: DashboardCacheDTO;
};

export type RefreshDashboardPageRequest = {
  pageId: RecordIdString;
};

export type RefreshDashboardPageResponse = {
  caches: DashboardCacheDTO[];
};

// ─── RPC 契约 ─────────────────────────────────────────────────────────────────

export interface AppRPC extends LegacyRPCSchema {
  bun: {
    requests: {
      query: { params: RawQueryRequest; response: RawQueryResponse };
      getAuthState: { params: Record<string, never>; response: AuthState };
      logout: { params: Record<string, never>; response: void };
      toggleWindowMaximized: { params: Record<string, never>; response: void };
      getAppBootstrap: { params: Record<string, never>; response: Result<AppBootstrap> };
      getSyncStatusV2: { params: Record<string, never>; response: Result<SyncStatusV2DTO> };
      triggerSyncRebuild: { params: Record<string, never>; response: Result<SyncStatusV2DTO> };
      reconnectRemote: { params: Record<string, never>; response: Result<ReconnectRemoteResponse> };
      getSettings: { params: Record<string, never>; response: Result<GetSettingsResponse> };
      saveSettings: { params: SaveSettingsRequest; response: Result<SaveSettingsResponse> };
      sendAiMessage: { params: SendAiMessageRequest; response: Result<SendAiMessageResponse> };
      resumeAiWorkflow: { params: ResumeAiWorkflowRequest; response: Result<ResumeAiWorkflowResponse> };
      cancelAiWorkflow: { params: CancelAiWorkflowRequest; response: Result<CancelAiWorkflowResponse> };
      executeAiAction: { params: ExecuteAiActionRequest; response: Result<ExecuteAiActionResponse> };
      listWorkbooks: { params: ListWorkbooksRequest; response: Result<ListWorkbooksResponse> };
      createBlankWorkbook: { params: CreateBlankWorkbookRequest; response: Result<CreateBlankWorkbookResponse> };
      listFolders: { params: ListFoldersRequest; response: Result<ListFoldersResponse> };
      createFolder: { params: CreateFolderRequest; response: Result<CreateFolderResponse> };
      moveFolder: { params: MoveFolderRequest; response: Result<MoveFolderResponse> };
      moveWorkbook: { params: MoveWorkbookRequest; response: Result<MoveWorkbookResponse> };
      listTemplates: { params: Record<string, never>; response: Result<ListTemplatesResponse> };
      createWorkbookFromTemplate: { params: CreateWorkbookFromTemplateRequest; response: Result<CreateWorkbookFromTemplateResponse> };
      getWorkbookData: { params: GetWorkbookDataRequest; response: Result<GetWorkbookDataResponse> };
      upsertRows: { params: UpsertRowsRequest; response: Result<UpsertRowsResponse> };
      deleteRows: { params: DeleteRowsRequest; response: Result<DeleteRowsResponse> };
      renameWorkbook: { params: RenameWorkbookRequest; response: Result<RenameWorkbookResponse> };
      updateSheetFields: { params: UpdateSheetFieldsRequest; response: Result<UpdateSheetFieldsResponse> };
      createSheet: { params: CreateSheetRequest; response: Result<CreateSheetResponse> };
      renameSheet: { params: RenameSheetRequest; response: Result<RenameSheetResponse> };
      resolveReferences: { params: ResolveReferencesRequest; response: Result<ResolveReferencesResponse> };
      listReferenceTargets: { params: Record<string, never>; response: Result<ListReferenceTargetsResponse> };
      searchReferenceCandidates: { params: SearchReferenceCandidatesRequest; response: Result<SearchReferenceCandidatesResponse> };
      getTableSchema: { params: GetTableSchemaRequest; response: Result<GetTableSchemaResponse> };
      saveResource: { params: SaveResourceRequest; response: Result<SaveResourceResponse> };
      saveResearchResource: { params: SaveResearchResourceRequest; response: Result<SaveResourceResponse> };
      getResourceDetail: { params: GetResourceDetailRequest; response: Result<ResourceDetailResponse> };
      searchResources: { params: SearchResourcesRequest; response: Result<SearchResourcesResponse> };
      createResearchSession: { params: CreateResearchSessionRequest; response: Result<ResearchSessionResponse> };
      getResearchSession: { params: GetResearchSessionRequest; response: Result<ResearchSessionResponse> };
      completeResearchSession: { params: CompleteResearchSessionRequest; response: Result<ResearchSessionResponse> };
      cancelResearchSession: { params: CancelResearchSessionRequest; response: Result<ResearchSessionResponse> };
      retryResourceEmbedding: { params: RetryResourceEmbeddingRequest; response: Result<RetryResourceEmbeddingResponse> };
      openResearchWindow: { params: OpenResearchWindowRequest; response: Result<OpenResearchWindowResponse> };
      generateResourceDraft: { params: GenerateResourceDraftRequest; response: Result<GenerateResourceDraftResponse> };
      listDashboardPages: { params: ListDashboardPagesRequest; response: Result<ListDashboardPagesResponse> };
      getDashboardPage: { params: GetDashboardPageRequest; response: Result<GetDashboardPageResponse> };
      createDashboardPage: { params: CreateDashboardPageRequest; response: Result<CreateDashboardPageResponse> };
      renameDashboardPage: { params: RenameDashboardPageRequest; response: Result<RenameDashboardPageResponse> };
      saveDashboardPageLayout: { params: SaveDashboardPageLayoutRequest; response: Result<SaveDashboardPageLayoutResponse> };
      listDashboardViews: { params: ListDashboardViewsRequest; response: Result<ListDashboardViewsResponse> };
      createDashboardView: { params: CreateDashboardViewRequest; response: Result<CreateDashboardViewResponse> };
      updateDashboardView: { params: UpdateDashboardViewRequest; response: Result<UpdateDashboardViewResponse> };
      previewDashboardView: { params: PreviewDashboardViewRequest; response: Result<PreviewDashboardViewResponse> };
      refreshDashboardView: { params: RefreshDashboardViewRequest; response: Result<RefreshDashboardViewResponse> };
      refreshDashboardPage: { params: RefreshDashboardPageRequest; response: Result<RefreshDashboardPageResponse> };
    };
    messages: {
      log: { msg: string };
      startLogin: Record<string, never>;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      pushRows: { rows: LegacyRowData[] };
      authStateChanged: { state: AuthState };
      aiMessageChunk: AiMessageChunkEvent;
      aiProgress: AiProgressEvent;
      aiSuspended: WorkflowSuspendedEvent;
      aiRunCancelled: AiRunCancelledEvent;
    };
  };
}
