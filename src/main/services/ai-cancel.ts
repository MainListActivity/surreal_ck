import type {
  AiRunCancelledEvent,
  CancelAiWorkflowRequest,
  CancelAiWorkflowResponse,
  ResearchSessionResponse,
} from "../../shared/rpc.types";
import { ROUTER_WORKFLOW_ID } from "../ai/mastra/workflows/router-workflow";
import { initMastraForCurrentUser } from "../ai/index";
import { assertAuthenticated } from "./context";
import { cancelResearchSession, getResearchSession } from "./resources";

export type CancelAiWorkflowDeps = {
  getResearchSession(req: { sessionId: string }): Promise<ResearchSessionResponse>;
  cancelResearchSession(req: { sessionId: string }): Promise<ResearchSessionResponse>;
  deleteWorkflowRun(req: { workflowName: string; runId: string }): Promise<void>;
};

export async function cancelAiWorkflow(req: CancelAiWorkflowRequest): Promise<CancelAiWorkflowResponse> {
  assertAuthenticated();
  return cancelAiWorkflowRun(req);
}

export async function cancelAiWorkflowRun(
  req: CancelAiWorkflowRequest,
  deps: CancelAiWorkflowDeps = defaultCancelAiWorkflowDeps(),
): Promise<CancelAiWorkflowResponse> {
  const session = req.sessionId
    ? (await deps.getResearchSession({ sessionId: req.sessionId })).session
    : null;
  const runId = req.runId;

  if (session?.status === "open") {
    await deps.cancelResearchSession({ sessionId: session.id });
  }
  if (runId) {
    await deps.deleteWorkflowRun({ workflowName: ROUTER_WORKFLOW_ID, runId });
  }

  const event = aiRunCancelledEvent({
    runId,
    sessionId: req.sessionId,
    reason: req.reason ?? "user-cancelled",
  });
  return { cancelled: true, event };
}

export function aiRunCancelledEvent(input: {
  runId: string;
  sessionId?: string;
  reason: AiRunCancelledEvent["reason"];
}): AiRunCancelledEvent {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    reason: input.reason,
    message: input.reason === "research-window-closed"
      ? "人工检索窗口已关闭，本次资源搜索已终止。"
      : "本次 AI 操作已终止。",
  };
}

function defaultCancelAiWorkflowDeps(): CancelAiWorkflowDeps {
  return {
    getResearchSession,
    cancelResearchSession,
    deleteWorkflowRun: async ({ workflowName, runId }) => {
      const mastra = initMastraForCurrentUser();
      const storage = mastra.getStorage?.();
      await storage?.stores?.workflows?.deleteWorkflowRunById?.({ workflowName, runId });
    },
  };
}
