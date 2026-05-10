import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core";
import type { AiChatMessage } from "../../shared/ai-context";
import { serializeContextForAi } from "../../shared/ai-context";
import type {
  AiMessageChunkEvent,
  AiToolCallRecord,
  SendAiMessageRequest,
  SendAiMessageResponse,
  WorkflowSuspendedEvent,
} from "../../shared/rpc.types";
import { createNavigationAgent, NAVIGATION_AGENT_ID } from "../ai/mastra/agents/navigation-agent";
import { CHITCHAT_AGENT_ID, createChitchatAgent } from "../ai/mastra/agents/chitchat-agent";
import { DASHBOARD_AGENT_ID, createDashboardAgent } from "../ai/mastra/agents/dashboard-agent";
import { CLAIM_ANALYSIS_AGENT_ID, createClaimAnalysisAgent } from "../ai/mastra/agents/claim-analysis-agent";
import { initMastraForCurrentUser } from "../ai/index";
import { assertAuthenticated } from "./context";
import { getAiSettings } from "./settings";
import { type AiProgressSender } from "./ai-progress";
import { runRouterChat } from "../ai/mastra/workflows/router-chat";
import type { SubAgentExecutors } from "../ai/mastra/workflows/router-workflow";
import { makeAgentExecutor } from "../ai/mastra/workflows/agent-executor";
import type { RouterLlmCaller } from "../ai/mastra/workflows/router-classifier";
import { recordAiToolCall } from "./audit";

export type AiChunkSender = (event: AiMessageChunkEvent) => void;
export type AiSuspendSender = (event: WorkflowSuspendedEvent) => void;

export function buildDegradedResponse(
  req: Pick<SendAiMessageRequest, "streamId" | "message">,
  content: string,
): SendAiMessageResponse {
  const message: SendAiMessageResponse["message"] = {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    context: req.message.context,
  };
  return { message, toolCalls: [], runId: crypto.randomUUID() };
}

export async function sendAiMessage(
  req: SendAiMessageRequest,
  pushChunk?: AiChunkSender,
  pushProgress?: AiProgressSender,
  onSuspend?: AiSuspendSender,
): Promise<SendAiMessageResponse> {
  assertAuthenticated();
  const settings = await getAiSettings();
  if (!settings.secretConfigured || !settings.apiKey?.trim()) {
    const res = buildDegradedResponse(req, "请先在设置中配置 AI API Key，才能使用 AI 功能。");
    pushChunk?.({ streamId: req.streamId, type: "done", message: res.message, toolCalls: [] });
    return res;
  }

  const mastra = initMastraForCurrentUser();
  if (!mastra.listAgents()[NAVIGATION_AGENT_ID]) {
    mastra.addAgent(createNavigationAgent(settings), NAVIGATION_AGENT_ID);
  }
  if (!mastra.listAgents()[DASHBOARD_AGENT_ID]) {
    mastra.addAgent(createDashboardAgent(settings), DASHBOARD_AGENT_ID);
  }
  if (!mastra.listAgents()[CLAIM_ANALYSIS_AGENT_ID]) {
    mastra.addAgent(createClaimAnalysisAgent(settings), CLAIM_ANALYSIS_AGENT_ID);
  }
  if (!mastra.listAgents()[CHITCHAT_AGENT_ID]) {
    mastra.addAgent(createChitchatAgent(settings), CHITCHAT_AGENT_ID);
  }

  const navigationAgent = mastra.getAgent(NAVIGATION_AGENT_ID);
  const dashboardAgent = mastra.getAgent(DASHBOARD_AGENT_ID);
  const claimAnalysisAgent = mastra.getAgent(CLAIM_ANALYSIS_AGENT_ID);
  const chitchatAgent = mastra.getAgent(CHITCHAT_AGENT_ID);

  const runId = crypto.randomUUID();
  const collectedToolCalls: AiToolCallRecord[] = [];
  const onToolCall = (call: AiToolCallRecord) => {
    collectedToolCalls.push(call);
    pushProgress?.({ kind: "tool-call", runId, toolId: call.toolName });
    void recordAiToolCall({ sessionId: runId, ...call });
  };

  const executors: SubAgentExecutors = {
    navigation: makeAgentExecutor(navigationAgent, { onToolCall }),
    dashboard: makeAgentExecutor(dashboardAgent, { onToolCall }),
    "claim-analysis": makeAgentExecutor(claimAnalysisAgent, { onToolCall }),
    chitchat: makeAgentExecutor(chitchatAgent, { onToolCall }),
  };

  const llmCaller: RouterLlmCaller = makeRouterLlmCaller(chitchatAgent);

  void runRouterChatGuarded(req, runId, mastra, executors, llmCaller, collectedToolCalls, pushChunk, pushProgress, onSuspend);

  return {
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      context: req.message.context,
    },
    toolCalls: [],
    runId,
  };
}

async function runRouterChatGuarded(
  req: SendAiMessageRequest,
  runId: string,
  mastra: Mastra,
  executors: SubAgentExecutors,
  llmCaller: RouterLlmCaller,
  collectedToolCalls: AiToolCallRecord[],
  pushChunk?: AiChunkSender,
  pushProgress?: AiProgressSender,
  onSuspend?: AiSuspendSender,
): Promise<void> {
  try {
    await runRouterChat({
      mastra,
      text: buildPrompt(req.message),
      userContext: req.message.context,
      executors,
      llmCaller,
      streamId: req.streamId,
      runId,
      pushChunk: (e) => pushChunk?.(e),
      pushProgress: (e) => pushProgress?.(e),
      onSuspend: (e) => onSuspend?.(e),
      toolCalls: collectedToolCalls,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushChunk?.({ streamId: req.streamId, type: "error", message });
  }
}

/** 用一个 agent（无工具的 chitchat 是稳妥选择）做轻量分类调用：generate 一次取最终文本即可。 */
export function makeRouterLlmCaller(agent: Agent): RouterLlmCaller {
  return async (prompt) => {
    const res = await agent.generate([{ role: "user", content: prompt }]);
    const text = (res as { text?: string }).text;
    return typeof text === "string" ? text : "";
  };
}

type CoreMessage = { role: "user" | "assistant"; content: string };

export function buildHistoryMessages(history: AiChatMessage[]): CoreMessage[] {
  return history.map((msg) => ({
    role: msg.role,
    content: msg.role === "user" ? buildPrompt(msg) : msg.content,
  }));
}

function buildPrompt(message: AiChatMessage): string {
  return [
    `用户问题：${message.content}`,
    "",
    "当前上下文快照：",
    JSON.stringify(serializeContextForAi(message.context), null, 2),
  ].join("\n");
}
