import { buildAgentModel } from "../../../src/internal-ai/model";
import { createHash } from "node:crypto";
/**
 * LCA06 授权内容研究 agent：联合平台授权语料与工作区私有材料生成可核验回答。
 *
 * 与 resource-agent 的差异：
 * - 执行窗口内同时持有调用者 workspace session 与 content_reader session
 *   （openContentSession 由执行 runtime 注入，模型不能选择安全上下文）；
 * - 平台语料经 Authorized Corpus 检索（关键词 + 结构化），证据句柄绑定精确版本、
 *   定位、哈希与授权修订；模型只能引用已登记句柄，后处理剔除伪造与无许可引用；
 * - 平台不可用/为空时降级为私有资料分析并显式标注 partial/unavailable；
 * - 挂起（resource-candidates / manual-research）只携带工作区资源候选，
 *   平台证据不进入 workflow state（LCA07 之前不沿用旧快照恢复）。
 */
import { Agent } from "@mastra/core/agent";
import type { Surreal } from "surrealdb";
import type { AiContextSnapshot, ResearchAuthorization } from "@surreal-ck/shared";
import type { SearchResourcesRequest, SearchResourcesResponse, ResourceDTO } from "@surreal-ck/shared/dto";
import type { SubAgentExecutor, SubAgentOutput } from "../workflows/router-workflow";
import { type AiSettings } from "./model-config";
import type { ContentResearchWindow } from "../../../src/research/window";
import type { EmbeddingProvider } from "../../../src/resources/research-save";
import {
  RESEARCH_EVIDENCE_LIMIT,
  retrieveAuthorizedCorpus,
} from "../../../src/research/corpus-retrieval";
import {
  assembleResearchAnswerText,
  buildResearchPrompt,
  createEvidenceRegistry,
  citationDTO,
  validateResearchAnswer,
  type CorpusAvailability,
} from "../../../src/research/research-answer";

export const RESEARCH_AGENT_ID = "researchAgent";

export const RESEARCH_INSTRUCTIONS = `你是 Surreal CK 的授权内容研究助手。
始终使用简体中文回答。
你收到的提示词里只会包含已登记的授权证据片段；只允许引用其中标注的句柄编号。
绝不编造句柄、版本号或条文文本；证据不足时明确说明缺口。`;

export function createResearchAgent(settings: AiSettings): Agent {
  return new Agent({
    name: "Research Agent",
    id: RESEARCH_AGENT_ID,
    instructions: RESEARCH_INSTRUCTIONS,
    model: buildAgentModel(settings, "research-agent"),
  });
}

/** 生产/测试共用的回答模型：输入提示词，输出模型文本。 */
export type ResearchAnswerModel = (prompt: string) => Promise<string>;

export type ResearchExecutorDeps = {
  embeddingProvider?: EmbeddingProvider;
  /** 默认：用调用者 session 查 session::db()（workspace db 名即 workspace 标识）。 */
  resolveWorkspaceId?(context: AiContextSnapshot, session?: Surreal): Promise<string>;
  /** 工作区私有材料检索（调用者 workspace session；授权由 db 边界与 schema PERMISSIONS 保证）。 */
  searchResources(req: SearchResourcesRequest, session?: Surreal): Promise<SearchResourcesResponse>;
  /** 生成模型（真实装配用 Mastra agent；测试注入替身并检查提示词）。 */
  answerModel: ResearchAnswerModel;
  loadResource?(resourceId: string, session?: Surreal): Promise<ResourceDTO>;
};

export function makeResearchExecutor(deps: ResearchExecutorDeps): SubAgentExecutor {
  const resolveWorkspaceId = deps.resolveWorkspaceId ?? resolveWorkspaceIdFromSession;
  const searchResources = deps.searchResources;

  return async ({ taskText, shared, surrealSession, openContentSession, selectedResourceIds, expectedAuthorization, expectedPlatformVersionIds, acceptAuthorizationChange }): Promise<SubAgentOutput> => {
    const workspaceId = await resolveWorkspaceId(shared.userContext, surrealSession);

    // ── 执行窗口：workspace session（透传）+ content session（runtime 注入，可选） ──
    // 窗口打开失败（IdP/投影/网络）一律按平台不可用降级，不中断 run、不外泄错误链。
    const [privateOutcome, corpusWindow] = await Promise.all([
      searchResources({
        workspaceId,
        query: taskText,
        context: buildResourceSearchContext(shared.userContext),
        limit: 5,
      }, surrealSession).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      openWindowQuietly(openContentSession),
    ]);

    try {
      if (!privateOutcome.ok) throw privateOutcome.error;
      const authorization: ResearchAuthorization = {
        workspaceId, kind: corpusWindow.kind,
        ...(corpusWindow.kind === "ready" ? { revision: corpusWindow.entitlementRevision,
          digest: corpusWindow.digest, leaseEndSeconds: corpusWindow.leaseEndSeconds } : {}),
      };
      if (corpusWindow.kind === "unavailable" && ["not_member", "member_removed", "workspace_inactive"].includes(corpusWindow.reason)) {
        return { text: "当前成员关系或工作区已失效。", confirmed: {}, researchAuthorization: authorization,
          suspend: { kind: "authorization_changed", query: taskText, authorization, resourceIds: [] } };
      }
      if (expectedAuthorization && !acceptAuthorizationChange && (
        expectedAuthorization.workspaceId !== workspaceId || expectedAuthorization.kind !== authorization.kind
        || expectedAuthorization.revision !== authorization.revision || expectedAuthorization.digest !== authorization.digest
        || (expectedAuthorization.leaseEndSeconds !== undefined && expectedAuthorization.leaseEndSeconds <= Date.now() / 1000)
      )) {
        return { text: "授权已变化，请重新检索或使用当前合法材料。", confirmed: {}, researchAuthorization: authorization,
          suspend: { kind: "authorization_changed", query: taskText, authorization, resourceIds: selectedResourceIds ?? [] } };
      }
      const privateSearch = privateOutcome.value;
      if (selectedResourceIds?.length) {
        try {
          if (!deps.loadResource) throw new Error("missing selection reader");
          const resources = await Promise.all([...new Set(selectedResourceIds)].map(id => deps.loadResource!(id, surrealSession)));
          privateSearch.results = resources.map(resource => ({ resource, score: 1, vectorScore: 0, keywordScore: 0, qualityScore: 0, recencyScore: 0 }));
          privateSearch.status = "hit";
        } catch {
          return { text: "所选材料当前不可访问，请重新检索。", confirmed: {}, researchAuthorization: authorization,
            suspend: { kind: "authorization_changed", query: taskText, authorization, resourceIds: [] } };
        }
      }
      let corpusAvailability: CorpusAvailability = corpusWindow.kind === "ready"
        ? "ready"
        : corpusWindow.kind === "empty"
          ? "empty"
          : "unavailable";
      let corpusNotice = corpusWindow.kind === "unavailable"
        ? "平台语料暂不可用（unavailable），本回答仅基于工作区私有资料（partial）。"
        : corpusWindow.kind === "empty"
          ? "平台语料当前没有可授权集合，本回答仅基于工作区私有资料（partial）。"
          : undefined;

      // ── 平台语料召回 + 证据登记（库层授权 + 本地校验双层） ──
      let platformEvidence: Awaited<ReturnType<typeof retrieveAuthorizedCorpus>> = {
        evidence: [],
        rejected: [],
        candidatesSeen: 0,
      };
      if (corpusWindow.kind === "ready" && corpusWindow.leaseEndSeconds <= Date.now() / 1000) {
        corpusAvailability = "unavailable";
        corpusNotice = "平台授权窗口已到期，请重新开始研究；本回答仅基于工作区私有资料（partial）。";
      } else if (corpusWindow.kind === "ready") {
        try {
          platformEvidence = await retrieveAuthorizedCorpus({
            session: corpusWindow.session, query: taskText, embeddingProvider: deps.embeddingProvider,
          });
        } catch {
          // 检索失败按平台不可用处理：不把原始错误带进模型上下文或日志。
          platformEvidence = { evidence: [], rejected: [], candidatesSeen: 0 };
          corpusAvailability = "unavailable";
          corpusNotice = "平台语料暂不可用（unavailable），本回答仅基于工作区私有资料（partial）。";
        }
      }

      if (expectedPlatformVersionIds && !acceptAuthorizationChange
        && expectedPlatformVersionIds.some(id => !platformEvidence.evidence.some(e => e.versionPublicId === id && e.quoteAllowed))) {
        return { text: "之前引用的平台材料已失效。", confirmed: {}, researchAuthorization: authorization,
          suspend: { kind: "authorization_changed", query: taskText, authorization, resourceIds: selectedResourceIds ?? [] } };
      }
      const registry = createEvidenceRegistry(RESEARCH_EVIDENCE_LIMIT);
      for (const item of platformEvidence.evidence) {
        registry.register({
          sourceType: "platform",
          title: item.title,
          quote: item.quote,
          quoteAllowed: item.quoteAllowed,
          platform: {
            versionId: item.versionId,
            itemId: item.itemId,
            versionPublicId: item.versionPublicId,
            sourceKey: item.sourceKey,
            sourceUrl: item.sourceUrl,
            locator: item.locator,
            quoteSha256: item.quoteSha256,
            bodySha256: item.bodySha256,
            kind: item.kind,
            versionLabel: null,
            entitlementRevision: corpusWindow.kind === "ready" ? corpusWindow.entitlementRevision : undefined,
          },
        });
      }

      // ── 私有材料证据：登记可作依据的片段（资源行来自调用者 workspace session） ──
      for (const result of privateSearch.results) {
        for (const item of result.resource.evidence) {
          if (registry.size >= RESEARCH_EVIDENCE_LIMIT) break;
          registry.register({
            sourceType: "private",
            title: result.resource.title,
            quote: item.text,
            private: {
              resourceId: result.resource.id,
              resourceType: result.resource.resourceType,
              sourceUrl: result.resource.sourceUrl ?? null,
              order: item.order,
            },
          });
        }
        if (registry.size >= RESEARCH_EVIDENCE_LIMIT) break;
      }

      const hasPlatformEvidence = platformEvidence.evidence.some((item) => item.quoteAllowed);
      const hasAnyEvidence = registry.size > 0;

      // ── 私有候选挂起：只在没有任何平台可引用证据时保持既有 UX ──
      if (!hasPlatformEvidence && privateSearch.status === "candidates" && privateSearch.results.length > 0) {
        return {
          researchAuthorization: authorization,
          text: "找到了可能相关的资源，请选择要用于回答的资料。",
          confirmed: {},
          suspend: {
            kind: "resource-candidates",
            authorization,
            candidates: privateSearch.results.map((item) => ({
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

      // ── 无任何证据：说明缺口，不调用模型生成假装有来源的结论 ──
      if (!hasAnyEvidence) {
        const gapText = assembleResearchAnswerText({
          question: taskText,
          registry,
          corpusAvailability,
          corpusNotice,
          candidateRejections: platformEvidence.rejected.length,
          analysisText: "",
          rejected: [],
          citedHandles: [],
        });
        return { text: gapText, confirmed: {}, researchAuthorization: authorization, deliveryProof: { authorization, platform: [], private: [] } };
      }

      // ── 模型分析：提示词只含登记证据；替身/真实模型都从同一入口注入 ──
      const prompt = buildResearchPrompt({ question: taskText, registry, corpusAvailability });
      let analysisText = "";
      let rejected: ReturnType<typeof validateResearchAnswer>["rejected"] = [];
      let citations: ReturnType<typeof validateResearchAnswer>["citations"] = [];
      try {
        const modelText = await deps.answerModel(prompt);
        const validated = validateResearchAnswer({ modelText, registry });
        analysisText = modelText;
        rejected = validated.rejected;
        citations = validated.citations;
      } catch {
        analysisText = "模型分析暂不可用；以上证据仅作登记，不构成结论。";
      }
      if (platformEvidence.evidence.length > 0 && corpusWindow.kind === "ready"
        && corpusWindow.leaseEndSeconds <= Date.now() / 1000) {
        return { text: "平台授权窗口已到期，未保存或输出平台证据。请重新开始授权研究（unavailable）。", confirmed: {}, researchAuthorization: authorization,
          suspend: { kind: "authorization_changed", query: taskText, authorization, resourceIds: selectedResourceIds ?? [] } };
      }

      // 来源事实/用户材料也展示了登记句柄，每个展示的句柄都必须有同号引用。
      citations = registry.entries.filter((entry) => entry.quoteAllowed)
        .map((entry) => citationDTO(registry, entry.handle, entry.handle));

      const text = assembleResearchAnswerText({
        question: taskText,
        registry,
        corpusAvailability,
        corpusNotice,
        candidateRejections: platformEvidence.rejected.length,
        analysisText,
        rejected,
        citedHandles: citations.map((c) => c.index),
      });

      return {
        text,
        researchAuthorization: authorization,
        deliveryProof: {
          authorization,
          platform: registry.entries.flatMap(e => e.platform ? [{ versionId: e.platform.versionId, bodySha256: e.platform.bodySha256 ?? "", cite: e.quoteAllowed }] : []),
          private: registry.entries.flatMap(e => e.private ? [{ resourceId: e.private.resourceId, quoteSha256: createHash("sha256").update(e.quote).digest("hex") }] : []),
        },
        confirmed: {},
        ...(citations.length > 0 ? { citations } : {}),
      };
    } finally {
      if (corpusWindow.kind === "ready") await corpusWindow.close();
    }
  };
}

function buildResourceSearchContext(context: AiContextSnapshot): SearchResourcesRequest["context"] {
  return {
    selectedRow: context.selectedRow ?? undefined,
    manualText: context.contextHint || undefined,
  };
}

/** 打开内容研究窗口；未注入或打开失败都归一为平台不可用（不外泄错误细节）。 */
async function openWindowQuietly(
  openContentSession?: () => Promise<ContentResearchWindow>,
): Promise<ContentResearchWindow> {
  if (!openContentSession) {
    return { kind: "unavailable", reason: "platform_error" };
  }
  try {
    return await openContentSession();
  } catch {
    return { kind: "unavailable", reason: "platform_error" };
  }
}

/** workspace-as-database：调用者 session 已绑定 workspace db，db 名即 workspace 标识。 */
async function resolveWorkspaceIdFromSession(
  _context: AiContextSnapshot,
  session?: Surreal,
): Promise<string> {
  if (!session) {
    throw new Error("research executor 缺少调用者 surrealSession，无法解析 workspace");
  }
  const results = await session.query<[string | null]>("RETURN session::db();");
  const db = results[0];
  if (!db) throw new Error("调用者 session 未绑定 workspace database");
  return String(db);
}
