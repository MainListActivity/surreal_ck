import type { AppNavigationIntent, ExecuteAiActionRequest, ExecuteAiActionResponse } from "../../shared/rpc.types";

export async function executeAiAction(req: ExecuteAiActionRequest): Promise<ExecuteAiActionResponse> {
  const navigation = toNavigation(req.intent);
  if (navigation) return { ok: true, navigation };

  return { ok: false, message: "暂不支持执行该 AI 动作。" };
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
