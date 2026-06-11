import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot } from "@surreal-ck/shared";
import type { ResourceCitationDTO } from "@surreal-ck/shared";
import type { SubAgentExecutor, SubAgentOutput } from "../workflows/router-workflow";
import { RESOURCE_TOOLS } from "../tools/resource-tools";
import { buildModelConfig, type AiSettings } from "./model-config";

export { RESOURCE_TOOLS } from "../tools/resource-tools";

export const RESOURCE_AGENT_ID = "resourceAgent";

export type ResourceEvidence = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
  capturedAt: string;
  order: number;
};

export type ResourceDTO = {
  id: string;
  /** 兼容旧契约字段；workspace-as-database 下 session 已绑定 db，新代码可不填。 */
  workspaceId?: string;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  structuredPayload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SearchResourcesRequest = {
  workspaceId?: string;
  query: string;
  context?: {
    selectedRow?: AiContextSnapshot["selectedRow"];
    document?: { title?: string; text?: string } | string;
    manualText?: string;
  };
  resourceType?: string;
  filters?: Record<string, unknown>;
  limit?: number;
  answerThreshold?: number;
  candidateThreshold?: number;
};

export type SearchResourcesResponse = {
  status: "hit" | "candidates" | "miss";
  indexStatus: "ready" | "index-disabled" | "index-pending" | "index-error";
  queryText: string;
  results: Array<{
    resource: ResourceDTO;
    score: number;
    vectorScore?: number;
    keywordScore?: number;
    qualityScore?: number;
    recencyScore?: number;
  }>;
};

export type CreateResearchSessionRequest = {
  workspaceId?: string;
  query: string;
  context?: Record<string, unknown>;
  resourceType: string;
  originatingRunId?: string;
};

export type ResearchSessionResponse = {
  session: {
    id: string;
    workspaceId?: string;
    query: string;
    resourceType: string;
    [key: string]: unknown;
  };
};

export type GetResourceDetailRequest = {
  resourceId: string;
};

export type ResourceDetailResponse = {
  resource: ResourceDTO;
};

export type SaveResourceRequest = {
  workspaceId: string;
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceTitle?: string;
  evidence: ResourceEvidence[];
  structuredPayload: Record<string, unknown>;
  quality: "ai-draft";
};

export const RESOURCE_INSTRUCTIONS = `你是 Surreal CK 的资源检索 AI 助手。
始终使用简体中文回答。
你的职责只有三类：
1. 使用 searchResources 检索 workspace 共享资源库，区分 hit、candidates、miss 和索引不可用状态。
2. 使用 getResourceDetail 读取资源主数据和证据，并在回答中使用 [1] 这类文本引用。
3. 如果普通对话需要沉淀新资源，只能使用 createResourceDraftIntent 生成 resource-draft 写确认意图。
不要直接保存资源；不要声称弱匹配是强证据；索引为 disabled、pending 或 error 时必须明确说明状态。`;

export function createResourceAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Resource Agent",
    id: RESOURCE_AGENT_ID,
    instructions: RESOURCE_INSTRUCTIONS,
    model: new ModelRouterLanguageModel(buildModelConfig(settings)),
    tools: RESOURCE_TOOLS,
  });
}

export type ResourceCitationAnswer = {
  text: string;
  citations: ResourceCitationDTO[];
};

export type ResourceRetrievalExecutorDeps = {
  /** 默认：用调用者 session 查 session::db()（workspace db 名即 workspace 标识）。 */
  resolveWorkspaceId?(context: AiContextSnapshot, session?: Surreal): Promise<string>;
  searchResources(req: SearchResourcesRequest, session?: Surreal): Promise<SearchResourcesResponse>;
  createResearchSession?(req: CreateResearchSessionRequest, session?: Surreal): Promise<ResearchSessionResponse>;
};

export type AnswerSelectedResourceIdsInput = {
  question: string;
  resourceIds: string[];
  getResourceDetail(req: GetResourceDetailRequest): Promise<Pick<ResourceDetailResponse, "resource">>;
};

export type CreateResourceDraftFromEvidenceInput = {
  workspaceId: string;
  resourceType: string;
  evidence: ResourceEvidence[];
  title?: string;
  summary?: string;
};

export function createResourceCitationAnswer(input: {
  question: string;
  resources: ResourceDTO[];
}): ResourceCitationAnswer {
  const citations = input.resources.map((resource, index): ResourceCitationDTO => ({
    index: index + 1,
    resourceId: resource.id,
    title: resource.title,
    sourceUrl: resource.sourceUrl,
    evidence: resource.evidence.slice(0, 3).map((item) => ({
      order: item.order,
      text: item.text,
    })),
  }));

  const lines = input.resources.map((resource, index) => {
    const citationIndex = index + 1;
    const evidenceText = resource.evidence[0]?.text;
    const basis = evidenceText ? `证据摘录：${evidenceText}` : resource.summary;
    return `[${citationIndex}] ${resource.title}：${resource.summary} ${basis}`;
  });

  return {
    text: [
      `基于资源库中与“${input.question}”相关的资料：`,
      ...lines,
    ].join("\n"),
    citations,
  };
}

export function makeResourceRetrievalExecutor(
  deps: ResourceRetrievalExecutorDeps,
): SubAgentExecutor {
  const resolveWorkspaceId = deps.resolveWorkspaceId ?? resolveWorkspaceIdFromSession;
  const searchResources = deps.searchResources;
  const createResearchSession = deps.createResearchSession;

  return async ({ taskText, shared, runId, surrealSession }): Promise<SubAgentOutput> => {
    const workspaceId = await resolveWorkspaceId(shared.userContext, surrealSession);
    const response = await searchResources({
      workspaceId,
      query: taskText,
      context: buildResourceSearchContext(shared.userContext),
      limit: 5,
    }, surrealSession);

    if (response.status === "hit" && response.results.length > 0) {
      const answer = createResourceCitationAnswer({
        question: taskText,
        resources: response.results.map((item) => item.resource),
      });
      return { text: answer.text, citations: answer.citations, confirmed: {} };
    }

    if (response.status === "candidates" && response.results.length > 0) {
      return {
        text: "找到了可能相关的资源，请选择要用于回答的资料。",
        confirmed: {},
        suspend: {
          kind: "resource-candidates",
          candidates: response.results.map((item) => ({
            id: item.resource.id,
            label: item.resource.title,
            summary: item.resource.summary,
            score: item.score,
            resourceType: item.resource.resourceType,
            sourceUrl: item.resource.sourceUrl,
          })),
        },
      };
    }

    if (response.status === "miss" && createResearchSession) {
      const resourceType = "generic_note";
      const created = await createResearchSession({
        workspaceId,
        query: taskText,
        context: buildResourceSearchContext(shared.userContext) ?? {},
        resourceType,
        originatingRunId: runId,
      }, surrealSession);
      return {
        text: "资源库没有找到足够相关的资料，已准备人工检索会话。",
        confirmed: {},
        suspend: {
          kind: "manual-research",
          sessionId: created.session.id,
          workspaceId,
          query: taskText,
          resourceType,
        },
      };
    }

    return {
      text: describeResourceSearchMiss(response.indexStatus),
      confirmed: {},
    };
  };
}

export async function answerSelectedResourceIds(
  input: AnswerSelectedResourceIdsInput,
): Promise<ResourceCitationAnswer> {
  const details = await Promise.all(input.resourceIds.map((resourceId) => input.getResourceDetail({ resourceId })));
  return createResourceCitationAnswer({
    question: input.question,
    resources: details.map((detail) => detail.resource),
  });
}

export function createResourceDraftFromEvidence(
  input: CreateResourceDraftFromEvidenceInput,
): SaveResourceRequest {
  if (!input.evidence.length) {
    throw new Error("生成资源草稿至少需要一段证据");
  }
  const first = input.evidence[0];
  const sourceTitle = first.sourceTitle ?? sourceTitleFromUrl(first.sourceUrl);
  return {
    workspaceId: input.workspaceId,
    resourceType: input.resourceType,
    title: input.title?.trim() || sourceTitle || "未命名资源",
    summary: input.summary?.trim() || summarizeEvidence(input.evidence),
    sourceUrl: first.sourceUrl,
    sourceTitle,
    evidence: input.evidence,
    structuredPayload: input.resourceType === "web_article"
      ? omitUndefinedRecord({ siteName: sourceTitle })
      : {},
    quality: "ai-draft",
  };
}

function sourceTitleFromUrl(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return undefined;
  }
}

function omitUndefinedRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function summarizeEvidence(evidence: ResourceEvidence[]): string {
  const text = evidence.map((item) => item.text.trim()).filter(Boolean).join(" ");
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function buildResourceSearchContext(context: AiContextSnapshot): SearchResourcesRequest["context"] {
  return {
    selectedRow: context.selectedRow ?? undefined,
    manualText: context.contextHint || undefined,
  };
}

function describeResourceSearchMiss(indexStatus: SearchResourcesResponse["indexStatus"]): string {
  if (indexStatus === "index-disabled") {
    return "资源库没有找到足够相关的资料；当前语义索引未配置，只使用了关键词检索。";
  }
  if (indexStatus === "index-pending") {
    return "资源库没有找到足够相关的资料；部分资源语义索引仍在处理中，当前结果可能不完整。";
  }
  if (indexStatus === "index-error") {
    return "资源库没有找到足够相关的资料；语义索引存在失败状态，需要重试索引或改用人工检索。";
  }
  return "资源库没有找到足够相关的资料。";
}

/** workspace-as-database：调用者 session 已绑定 workspace db，db 名即 workspace 标识。 */
async function resolveWorkspaceIdFromSession(
  _context: AiContextSnapshot,
  session?: Surreal,
): Promise<string> {
  if (!session) {
    throw new Error("resource-retrieval executor 缺少调用者 surrealSession，无法解析 workspace");
  }
  const results = await session.query<[string | null]>("RETURN session::db();");
  const db = results[0];
  if (!db) throw new Error("调用者 session 未绑定 workspace database");
  return String(db);
}
