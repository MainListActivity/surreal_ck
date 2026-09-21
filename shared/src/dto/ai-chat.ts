import { z } from "zod";
import type { AiChatMessage } from "../ai-context";
import type { DashboardBuilderSpec, DashboardPreviewResponse, DashboardViewDraftDTO } from "./dashboard";
import type { SaveResourceRequest } from "./resource";
import type { RecordIdString } from "./transport";

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

export type RecordWriteProposal = {
  type: "record-write-proposal";
  operation: "create" | "update";
  sheetId: string;
  /** update 必填；create 不携带。 */
  recordId?: RecordIdString;
  proposals: RowPatchProposal["proposals"];
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
  | RecordWriteProposal
  | RowPatchIntent
  | ResourceDraftIntent;

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
  preview: z.custom<DashboardPreviewResponse>().optional(),
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

const RecordWriteProposalSchema = z.object({
  type: z.literal("record-write-proposal"),
  operation: z.enum(["create", "update"]),
  sheetId: z.string(),
  recordId: z.string().optional(),
  proposals: z.array(z.object({
    field: z.string(),
    currentValue: z.unknown(),
    suggestedValue: z.unknown(),
    basis: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
}).superRefine((value, ctx) => {
  if (value.operation === "update" && !value.recordId) {
    ctx.addIssue({ code: "custom", path: ["recordId"], message: "update proposal requires recordId" });
  }
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
  RecordWriteProposalSchema,
  RowPatchIntentSchema,
  ResourceDraftIntentSchema,
]);

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

// ─── /api/chat/stream WS 转发协议（issue D1-05） ─────────────────────────────
//
// POST /api/chat 启动 router workflow 后，客户端连 `/api/chat/stream?runId=&streamToken=`
// 监听这一类事件。**仅** workflow 自身的运行过程（routing / agent 步骤 / LLM 吐字 /
// suspend 决策 / 终态），不转发 SurrealDB LIVE——数据行变更由浏览器直连 SurrealDB 的
// LIVE SELECT 订阅。每条事件一行 JSON。
//
// progress：复用 AiProgressEvent（routing / agent-step / tool-call）。
// chunk：LLM 流式增量文本。
// suspend：复用 WorkflowSuspendedEvent（候选 / 写确认等待用户决策）。
// done / error：终态，服务端随后关闭 WS（后台 workflow 不受影响）。
// ping：服务端保活心跳，客户端可忽略。

export type ChatStreamEvent =
  | { kind: "progress"; runId: string; progress: AiProgressEvent }
  | { kind: "chunk"; runId: string; text: string }
  | { kind: "suspend"; runId: string; payload: WorkflowSuspendedEvent }
  | { kind: "done"; runId: string; message: AiChatMessage; toolCalls: AiToolCallRecord[] }
  | { kind: "error"; runId: string; code: string; message: string }
  | { kind: "ping"; runId: string };

/** done / error 之后 RunBus 仍保留事件供迟到订阅重放的窗口。 */
export const CHAT_STREAM_TERMINAL_RETENTION_MS = 60_000;
