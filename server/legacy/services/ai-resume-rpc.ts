import type {
  AiMessageChunkEvent,
  AiProgressEvent,
  ResumeAiWorkflowRequest,
  ResumeAiWorkflowResponse,
  WorkflowSuspendedEvent,
  AiToolCallRecord,
} from "../../shared/rpc.types";
import { initMastraForCurrentUser } from "../ai/index";
import {
  CHITCHAT_AGENT_ID,
  createChitchatAgent,
} from "../ai/mastra/agents/chitchat-agent";
import {
  CLAIM_ANALYSIS_AGENT_ID,
  createClaimAnalysisAgent,
} from "../ai/mastra/agents/claim-analysis-agent";
import {
  DASHBOARD_AGENT_ID,
  createDashboardAgent,
} from "../ai/mastra/agents/dashboard-agent";
import {
  NAVIGATION_AGENT_ID,
  createNavigationAgent,
} from "../ai/mastra/agents/navigation-agent";
import {
  RESOURCE_AGENT_ID,
  answerSelectedResourceIds,
  createResourceAgent,
  makeResourceRetrievalExecutor,
} from "../ai/mastra/agents/resource-agent";
import { makeAgentExecutor } from "../ai/mastra/workflows/agent-executor";
import type { SubAgentExecutors } from "../ai/mastra/workflows/router-workflow";
import { ROUTER_WORKFLOW_ID } from "../ai/mastra/workflows/router-workflow";
import { resumeAiWorkflow } from "./ai-resume";
import { makeRouterLlmCaller } from "./ai-chat";
import { recordAiToolCall } from "./audit";
import { assertAuthenticated } from "./context";
import { createResearchSession } from "./resources";
import { getAiSettings } from "./settings";

export type ResumeRpcSenders = {
  pushChunk?: (event: AiMessageChunkEvent) => void;
  pushProgress?: (event: AiProgressEvent) => void;
  onSuspend?: (event: WorkflowSuspendedEvent) => void;
};

export async function resumeAiWorkflowFromRpc(
  req: ResumeAiWorkflowRequest,
  senders: ResumeRpcSenders,
): Promise<ResumeAiWorkflowResponse> {
  assertAuthenticated();
  const settings = await getAiSettings();
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
  if (!mastra.listAgents()[RESOURCE_AGENT_ID]) {
    mastra.addAgent(createResourceAgent(settings), RESOURCE_AGENT_ID);
  }
  if (!mastra.listAgents()[CHITCHAT_AGENT_ID]) {
    mastra.addAgent(createChitchatAgent(settings), CHITCHAT_AGENT_ID);
  }

  const navigationAgent = mastra.getAgent(NAVIGATION_AGENT_ID);
  const dashboardAgent = mastra.getAgent(DASHBOARD_AGENT_ID);
  const claimAnalysisAgent = mastra.getAgent(CLAIM_ANALYSIS_AGENT_ID);
  const chitchatAgent = mastra.getAgent(CHITCHAT_AGENT_ID);
  const onToolCall = (call: AiToolCallRecord) => {
    senders.pushProgress?.({ kind: "tool-call", runId: req.runId, toolId: call.toolName });
    void recordAiToolCall({ sessionId: req.runId, ...call });
  };

  const executors: SubAgentExecutors = {
    navigation: makeAgentExecutor(navigationAgent, { onToolCall }),
    dashboard: makeAgentExecutor(dashboardAgent, { onToolCall }),
    "claim-analysis": makeAgentExecutor(claimAnalysisAgent, { onToolCall }),
    "resource-retrieval": makeResourceRetrievalExecutor({ createResearchSession }),
    chitchat: makeAgentExecutor(chitchatAgent, { onToolCall }),
  };

  // resume 时无完整 userContext 快照（已经写进 storage 的 state 里），用空快照占位
  const placeholderUserContext = {
    route: { screen: "home" },
    workbook: null,
    sheet: null,
    selectedRow: null,
    contextHint: "",
  };

  return resumeAiWorkflow({
    mastra,
    runId: req.runId,
    decision: req.decision,
    workflowName: req.workflowName ?? ROUTER_WORKFLOW_ID,
    executors,
    llmCaller: makeRouterLlmCaller(chitchatAgent),
    userContext: placeholderUserContext,
    streamId: `resume-${req.runId}`,
    pushChunk: senders.pushChunk,
    pushProgress: senders.pushProgress,
    onSuspend: senders.onSuspend,
    answerResourceSelection: ({ resourceIds, taskText }) => answerSelectedResourceIds({
      question: taskText,
      resourceIds,
    }),
  });
}
