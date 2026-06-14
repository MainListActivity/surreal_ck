/**
 * 生产 Mastra 装配：把 5 agents、llmCaller、SubAgentExecutors、per-run Mastra
 * 串成 ChatRunner / ChatResumer，供 createAiChatService 注入。
 *
 * 关键决策（与 D1 收口对齐）：
 *   - 每 run 一个 Mastra 实例：startChat/resumeChat 内 new Mastra({ storage: SurrealMastraStore(()=>session) })，
 *     resolver 闭包绑死本 run 的 surrealSession，零并发串台风险。
 *   - llmCaller 复用 chitchat agent 的 model：agent.generate(buildRouterPrompt(text)) → text。
 */

import type { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { createChitchatAgent } from "../../ai/mastra/agents/chitchat-agent";
import { createClaimAnalysisAgent } from "../../ai/mastra/agents/claim-analysis-agent";
import { createDashboardAgent } from "../../ai/mastra/agents/dashboard-agent";
import {
  answerSelectedResourceIds,
  createResourceAgent,
  makeResourceRetrievalExecutor,
  type ResourceRetrievalExecutorDeps,
} from "../../ai/mastra/agents/resource-agent";
import { createResourceSearchService } from "../resources/resource-search";
import type { EmbeddingProvider } from "../resources/research-save";
import { createNavigationAgent } from "../../ai/mastra/agents/navigation-agent";
import type { AiSettings } from "../../ai/mastra/agents/model-config";
import { initMastraForCurrentUser } from "../../ai/mastra";
import { makeAgentExecutor } from "../../ai/mastra/workflows/agent-executor";
import { runRouterChat as defaultRunRouterChat, type RunRouterChatInput } from "../../ai/mastra/workflows/router-chat";
import type { RouterLlmCaller } from "../../ai/mastra/workflows/router-classifier";
import {
  ROUTER_RUNTIME_KEY,
  ROUTER_WORKFLOW_ID,
  type RouterRuntime,
  type SubAgentExecutors,
} from "../../ai/mastra/workflows/router-workflow";
import { RequestContext } from "@mastra/core/request-context";
import type { Surreal } from "surrealdb";
import type { ChatRunner, ChatResumer } from "./chat-service";

/**
 * 把一个已构造好的 Mastra Agent 适配成 RouterLlmCaller：
 *   prompt → agent.generate(prompt) → response.text
 *
 * classifier 内部已对返回文本做 JSON.parse + zod 校验，解析失败兜底 chitchat plan，
 * 所以这里只关心「把 prompt 喂进去、把 text 拿出来」，不解析、不重试。
 */
export function buildRouterLlmCaller(agent: Agent): RouterLlmCaller {
  return async (prompt: string): Promise<string> => {
    const response = await agent.generate(prompt);
    return response.text ?? "";
  };
}

export type AssembleAgents = {
  navigationAgent: Agent;
  dashboardAgent: Agent;
  claimAnalysisAgent: Agent;
  chitchatAgent: Agent;
};

export type AssembleExecutorDeps = {
  /** 资源检索 executor 的外部依赖（搜索 / workspace 解析 / 研究 session）。未提供则不挂 resource-retrieval。 */
  resource?: ResourceRetrievalExecutorDeps;
};

/**
 * RR-014 生产默认 resource deps：每次调用用 executor 透传进来的调用者 session
 * 现场构造检索服务——session 属于单个 run，deps 本身无状态、可在装配期共享。
 */
export function createCallerSessionResourceDeps(
  embeddingProvider?: EmbeddingProvider,
): ResourceRetrievalExecutorDeps {
  function requireSession(session: Surreal | undefined): Surreal {
    if (!session) {
      throw new Error("resource-retrieval deps 缺少调用者 surrealSession（不存在 root/service 兜底）");
    }
    return session;
  }
  return {
    searchResources: (req, session) =>
      createResourceSearchService({ session: requireSession(session), embeddingProvider })
        .searchResources(req),
    createResearchSession: (req, session) =>
      createResourceSearchService({ session: requireSession(session) })
        .createResearchSession(req),
  };
}

/** resume 决策（resource-candidates-chosen / manual-research-completed）的 citation 回答生成器。 */
function buildAnswerResourceSelection(session: Surreal): NonNullable<RouterRuntime["answerResourceSelection"]> {
  const service = createResourceSearchService({ session });
  return ({ resourceIds, taskText }) =>
    answerSelectedResourceIds({
      question: taskText,
      resourceIds,
      getResourceDetail: (req) => service.getResourceDetail(req),
    });
}

/**
 * 4 个基础 agent → makeAgentExecutor 闭包；可选 resource-retrieval 走专用 executor。
 * router-workflow 的 SubAgentExecutors 类型已声明 resource-retrieval 可选，未挂时
 * 路由到 resource-retrieval 的 plan 会抛 "缺少 ... executor"——所以接入资源能力前
 * 应让 classifier 不要产出该 category，或在装配时提供 resource deps。
 */
export function buildExecutors(agents: AssembleAgents, deps: AssembleExecutorDeps = {}): SubAgentExecutors {
  const executors: SubAgentExecutors = {
    navigation: makeAgentExecutor(agents.navigationAgent),
    dashboard: makeAgentExecutor(agents.dashboardAgent),
    "claim-analysis": makeAgentExecutor(agents.claimAnalysisAgent),
    chitchat: makeAgentExecutor(agents.chitchatAgent),
  };
  if (deps.resource) {
    executors["resource-retrieval"] = makeResourceRetrievalExecutor(deps.resource);
  }
  return executors;
}

// ─── createMastraRunner：把 ChatService 需要的 { runner, resumer } 装齐 ─────

export type CreateMastraRunnerOptions = {
  /** 模型 provider / model / apiKey 等；交给 model-config.buildModelConfig 用。 */
  settings?: AiSettings;
  /** 资源 executor 的外部依赖；默认 createCallerSessionResourceDeps（调用者 session 检索服务）。 */
  resource?: ResourceRetrievalExecutorDeps;
  /** 检索查询向量生成器（服务端持 key）；缺席时检索退化为关键词 + 索引状态推断。 */
  embeddingProvider?: EmbeddingProvider;

  // ── 以下注入点用于测试与未来替换；生产默认从 agents/index 装配 ──
  /** 默认：用 settings 构造 5 agents（含 resource agent）。 */
  buildAgents?: (settings: AiSettings) => AssembleAgents;
  /** 默认：复用 chitchat agent 的 model 作为 RouterLlmCaller。 */
  buildLlmCaller?: (agents: AssembleAgents) => RouterLlmCaller;
  /** 默认：每 run 一个 Mastra，storage resolver 闭包绑死当前 session + subject。 */
  buildMastra?: (surrealSession: Surreal, subject: string) => Mastra;
  /** 默认：真 runRouterChat。 */
  runRouterChat?: (input: RunRouterChatInput) => Promise<{ runId: string; finalText: string; status: "success" | "suspended" }>;
  /** 默认：真 Mastra resume（按 runId 找 workflow 并 run.resume）。 */
  resumeWorkflow?: (input: ResumeWorkflowInput) => Promise<{ runId: string; finalText: string; status: "success" | "suspended" | "cancelled" }>;
};

export type ResumeWorkflowInput = {
  mastra: Mastra;
  runId: string;
  decision: import("@surreal-ck/shared").ResumeDecision;
  surrealSession: Surreal;
  executors: SubAgentExecutors;
  llmCaller: RouterLlmCaller;
  answerResourceSelection?: RouterRuntime["answerResourceSelection"];
  userContext: import("@surreal-ck/shared").AiContextSnapshot;
  streamId: string;
  pushChunk: NonNullable<RouterRuntime["pushChunk"]>;
  pushProgress: NonNullable<RouterRuntime["pushProgress"]>;
  onSuspend: NonNullable<RouterRuntime["onSuspend"]>;
};

const defaultBuildAgents: NonNullable<CreateMastraRunnerOptions["buildAgents"]> = (settings) => ({
  navigationAgent: createNavigationAgent(settings),
  dashboardAgent: createDashboardAgent(settings),
  claimAnalysisAgent: createClaimAnalysisAgent(settings),
  chitchatAgent: createChitchatAgent(settings),
});

const defaultBuildLlmCaller: NonNullable<CreateMastraRunnerOptions["buildLlmCaller"]> = (agents) =>
  buildRouterLlmCaller(agents.chitchatAgent);

const defaultBuildMastra: NonNullable<CreateMastraRunnerOptions["buildMastra"]> = (session, subject) =>
  initMastraForCurrentUser(() => ({ db: session, subject }));

/**
 * 默认 resume 实现：用 storage 校验 runId 是否已 suspended，然后 run.resume({ resumeData, requestContext })。
 * 与 legacy/services/ai-resume.ts 的差异：runtime 里**带上调用者 surrealSession**（D1-04 resume 用新 session）。
 */
const defaultResumeWorkflow: NonNullable<CreateMastraRunnerOptions["resumeWorkflow"]> = async (input) => {
  const wf = input.mastra.getWorkflow(ROUTER_WORKFLOW_ID);
  const storage = input.mastra.getStorage?.();
  const stored = await storage?.stores?.workflows?.getWorkflowRunById?.({
    workflowName: ROUTER_WORKFLOW_ID,
    runId: input.runId,
  });
  if (!stored) {
    return { runId: input.runId, finalText: "", status: "cancelled" };
  }
  const run = await wf.createRun({ runId: input.runId });
  const requestContext = new RequestContext();
  const runtime: RouterRuntime = {
    userContext: input.userContext,
    surrealSession: input.surrealSession,
    executors: input.executors,
    llmCaller: input.llmCaller,
    streamId: input.streamId,
    runId: input.runId,
    pushChunk: input.pushChunk,
    pushProgress: input.pushProgress,
    onSuspend: input.onSuspend,
    answerResourceSelection: input.answerResourceSelection,
  };
  requestContext.set(ROUTER_RUNTIME_KEY, runtime);

  const result = await run.resume({ resumeData: { decision: input.decision }, requestContext });
  if (result.status === "success") {
    const finalText = (result.result as { finalText?: string } | undefined)?.finalText ?? "";
    return { runId: input.runId, finalText, status: "success" };
  }
  if (result.status === "suspended") {
    return { runId: input.runId, finalText: "", status: "suspended" };
  }
  return { runId: input.runId, finalText: "", status: "cancelled" };
};

/**
 * 把 5 agents、llmCaller、per-run Mastra、runRouterChat / resume 装成 { runner, resumer }。
 * 注入到 createAiChatService 即生产装配完成。
 *
 * 每 run 一个 Mastra（决策 #1）：runner/resumer 内每次 buildMastra(session)，resolver
 * 闭包绑死本 run 的 session，避免并发串台；agents / llmCaller 只构造一次（无 session 依赖）。
 */
export function createMastraRunner(options: CreateMastraRunnerOptions = {}): { runner: ChatRunner; resumer: ChatResumer } {
  const buildAgents = options.buildAgents ?? defaultBuildAgents;
  const buildLlmCaller = options.buildLlmCaller ?? defaultBuildLlmCaller;
  const buildMastra = options.buildMastra ?? defaultBuildMastra;
  const runRouterChatImpl = options.runRouterChat ?? defaultRunRouterChat;
  const resumeWorkflowImpl = options.resumeWorkflow ?? defaultResumeWorkflow;

  // agents 在装配时一次性构造（无 session 依赖）；resource agent 按需添加到 executors。
  let cachedAgents: AssembleAgents | undefined;
  let cachedExecutors: SubAgentExecutors | undefined;
  let cachedLlm: RouterLlmCaller | undefined;

  function ensureAgents(): { agents: AssembleAgents; executors: SubAgentExecutors; llm: RouterLlmCaller } {
    if (!cachedAgents) {
      // 只有 default buildAgents 才需要真 settings；测试注入自定义 buildAgents 时允许 settings 缺席。
      if (!options.buildAgents && !options.settings) {
        throw new Error("createMastraRunner: missing AiSettings (provider/model/apiKey)");
      }
      cachedAgents = buildAgents(options.settings ?? ({} as AiSettings));
      cachedExecutors = buildExecutors(cachedAgents, {
        resource: options.resource ?? createCallerSessionResourceDeps(options.embeddingProvider),
      });
      cachedLlm = buildLlmCaller(cachedAgents);
    }
    return { agents: cachedAgents, executors: cachedExecutors!, llm: cachedLlm! };
  }

  return {
    async runner(input) {
      const { executors, llm } = ensureAgents();
      const mastra = buildMastra(input.surrealSession, input.ownerSubject);
      return runRouterChatImpl({
        mastra,
        text: input.text,
        userContext: input.userContext,
        surrealSession: input.surrealSession,
        executors,
        llmCaller: llm,
        streamId: input.streamId,
        runId: input.runId,
        planOverride: input.planOverride,
        pushChunk: input.pushChunk,
        pushProgress: input.pushProgress,
        onSuspend: input.onSuspend,
        answerResourceSelection: buildAnswerResourceSelection(input.surrealSession),
      });
    },

    async resumer(input) {
      const { executors, llm } = ensureAgents();
      const mastra = buildMastra(input.surrealSession);
      return resumeWorkflowImpl({
        mastra,
        runId: input.runId,
        decision: input.decision,
        surrealSession: input.surrealSession,
        executors,
        llmCaller: llm,
        answerResourceSelection: buildAnswerResourceSelection(input.surrealSession),
        userContext: input.userContext,
        streamId: input.streamId,
        pushChunk: input.pushChunk,
        pushProgress: input.pushProgress,
        onSuspend: input.onSuspend,
      });
    },
  };
}

// 防止「未使用 createResourceAgent」误判：保留显式 re-export，未来若需独立暴露资源 agent 也方便。
export { createResourceAgent };
