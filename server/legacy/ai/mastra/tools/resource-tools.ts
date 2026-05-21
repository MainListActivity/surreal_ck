import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getResourceDetail,
  searchResources,
  type SearchResourcesRequest,
} from "../../../services/resources";

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
  execute: async (input) => searchResources(input as SearchResourcesRequest),
});

export const getResourceDetailTool = createTool({
  id: "getResourceDetail",
  description: "按资源 id 读取资源详情、证据、structuredPayload、embedding 状态和 research session 关联。",
  inputSchema: z.object({
    resourceId: z.string(),
  }),
  outputSchema: z.record(z.string(), z.unknown()),
  execute: async ({ resourceId }) => getResourceDetail({ resourceId }),
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
