import type { AppNavigationIntent, ExecuteAiActionRequest, ExecuteAiActionResponse } from "../../shared/rpc.types";
import { initMastraForCurrentUser } from "../ai/index";
import { ROUTER_WORKFLOW_ID } from "../ai/mastra/workflows/router-workflow";

export async function executeAiAction(req: ExecuteAiActionRequest): Promise<ExecuteAiActionResponse> {
  const navigation = toNavigation(req.intent);
  if (navigation) {
    await tryDeleteWorkflowRun(req);
    return { ok: true, navigation };
  }

  return { ok: false, message: "暂不支持执行该 AI 动作。" };
}

async function tryDeleteWorkflowRun(req: ExecuteAiActionRequest): Promise<void> {
  if (!req.runId) return;
  const workflowName = req.workflowName ?? ROUTER_WORKFLOW_ID;
  try {
    const mastra = initMastraForCurrentUser();
    const storage = mastra.getStorage?.();
    await storage?.stores?.workflows?.deleteWorkflowRunById?.({ workflowName, runId: req.runId });
  } catch (err) {
    console.warn("[ai-actions] deleteWorkflowRunById failed:", err);
  }
}

function toNavigation(intent: ExecuteAiActionRequest["intent"]): AppNavigationIntent | null {
  if (intent.type === "navigate") {
    if ("screen" in intent) return intent;
    return { type: "navigate", screen: intent.route };
  }

  if (intent.type === "open-workbook") {
    return { type: "navigate", screen: "editor", workbookId: intent.workbookId };
  }

  if (intent.type === "open-dashboard") {
    return { type: "navigate", screen: "dashboard", dashboardPageId: intent.dashboardId };
  }

  if (intent.type === "open-record") {
    return {
      type: "navigate",
      screen: "editor",
      workbookId: intent.workbookId,
      sheetId: intent.sheetId,
    };
  }

  return null;
}
