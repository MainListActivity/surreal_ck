import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getSurrealSession, type ToolRequestContext } from "./tool-session";

/**
 * 资源检索 / 详情读取依赖 workspace 内的资源库 + 向量检索 schema，这些表在 web pivot 后的
 * workspace-template 里尚未定稿（embedding provider key 还得在后端，走 /api/resources/research/save）。
 * 在 schema 定稿前，这两个 tool 取到调用者 session 后明确抛 TODO，绝不退回 legacy 全局连接 / root。
 */
const RESOURCE_SCHEMA_TODO =
  "TODO: 资源库 / 向量检索 schema 在 web pivot 后尚未定稿，searchResources / getResourceDetail 暂不可用（不退回 root/legacy 连接）";

const EvidenceInputSchema = z.object({
  text: z.string().trim().min(1),
  sourceUrl: z.string().trim().url().optional(),
  sourceTitle: z.string().trim().min(1).optional(),
  capturedAt: z.string().datetime(),
  order: z.number().int().nonnegative(),
});

const ResourceSearchContextSchema = z.object({
  selectedRow: z.record(z.string(), z.unknown()).optional(),
  document: z.union([
    z.object({ title: z.string().optional(), text: z.string().optional() }),
    z.string(),
  ]).optional(),
  manualText: z.string().optional(),
}).optional();

const ResourceSearchFiltersSchema = z.object({
  tags: z.array(z.string()).optional(),
  sourceDomain: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
}).optional();

export const searchResourcesTool = createTool({
  id: "searchResources",
  description: "检索 workspace 共享资源库，返回 hit/candidates/miss、索引状态、资源候选和混合分数。",
  inputSchema: z.object({
    workspaceId: z.string(),
    query: z.string(),
    context: ResourceSearchContextSchema,
    resourceType: z.string().optional(),
    filters: ResourceSearchFiltersSchema,
    limit: z.number().int().positive().optional(),
    answerThreshold: z.number().optional(),
    candidateThreshold: z.number().optional(),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (_input, ctx) => {
    // 先确保调用者 session 存在（兑现「所有 DB 访问都以调用者身份」），再因 schema 未定稿抛 TODO
    getSurrealSession(ctx as ToolRequestContext);
    throw new Error(RESOURCE_SCHEMA_TODO);
  },
});

export const getResourceDetailTool = createTool({
  id: "getResourceDetail",
  description: "按资源 id 读取资源详情、证据、structuredPayload、embedding 状态和 research session 关联。",
  inputSchema: z.object({
    resourceId: z.string(),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async (_input, ctx) => {
    getSurrealSession(ctx as ToolRequestContext);
    throw new Error(RESOURCE_SCHEMA_TODO);
  },
});

export const createResourceDraftIntentTool = createTool({
  id: "createResourceDraftIntent",
  description: "生成 resource-draft 写确认意图。该工具不保存资源，必须等待用户确认后由通用写确认路径处理。",
  inputSchema: z.object({
    workspaceId: z.string(),
    resourceType: z.string().default("generic_note"),
    title: z.string(),
    summary: z.string(),
    sourceUrl: z.string().url().optional(),
    sourceTitle: z.string().optional(),
    evidence: z.array(EvidenceInputSchema).default([]),
    tags: z.array(z.string()).optional(),
    structuredPayload: z.record(z.string(), z.unknown()).optional(),
    explanation: z.string().optional(),
  }),
  outputSchema: z.object({
    intent: z.object({
      type: z.literal("resource-draft"),
      draft: z.record(z.string(), z.unknown()),
      explanation: z.string().optional(),
    }),
  }),
  execute: async (input) => ({
    intent: {
      type: "resource-draft" as const,
      draft: {
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        title: input.title,
        summary: input.summary,
        sourceUrl: input.sourceUrl,
        sourceTitle: input.sourceTitle,
        evidence: input.evidence,
        tags: input.tags,
        structuredPayload: input.structuredPayload ?? {},
        quality: "ai-draft" as const,
      },
      explanation: input.explanation,
    },
  }),
});

export const RESOURCE_TOOLS = {
  searchResources: searchResourcesTool,
  getResourceDetail: getResourceDetailTool,
  createResourceDraftIntent: createResourceDraftIntentTool,
} as const;
