import type {
  AppNavigationIntent,
  DashboardDraftIntent,
  DashboardWidgetLayoutDTO,
  ExecuteAiActionRequest,
  ExecuteAiActionResponse,
} from "../../shared/rpc.types";
import { initMastraForCurrentUser } from "../ai/index";
import { ROUTER_WORKFLOW_ID } from "../ai/mastra/workflows/router-workflow";
import {
  createDashboardPage,
  createDashboardView,
  getDashboardPage,
  listDashboardPages,
  saveDashboardPageLayout,
} from "./dashboards";

export async function executeAiAction(req: ExecuteAiActionRequest): Promise<ExecuteAiActionResponse> {
  const navigation = toNavigation(req.intent);
  if (navigation) {
    await tryDeleteWorkflowRun(req);
    return { ok: true, navigation };
  }

  if (req.intent.type === "dashboard-draft") {
    const saved = await saveDashboardDraftIntent(req.intent);
    await tryDeleteWorkflowRun(req);
    return {
      ok: true,
      message: "仪表盘草稿已保存。",
      navigation: {
        type: "navigate",
        screen: "dashboard",
        dashboardPageId: saved.pageId,
        workbookId: req.intent.draft.workbookId,
      },
    };
  }

  return { ok: false, message: "暂不支持执行该 AI 动作。" };
}

async function saveDashboardDraftIntent(intent: DashboardDraftIntent): Promise<{ pageId: string }> {
  const draft = { ...intent.draft, status: "active" as const };
  const created = await createDashboardView({ draft });
  const pages = await listDashboardPages({
    workspaceId: draft.workspaceId,
    workbookId: draft.workbookId,
  });
  const page = pages.pages[0]
    ?? (await createDashboardPage({
      workspaceId: draft.workspaceId,
      workbookId: draft.workbookId,
      title: "概览",
    })).page;

  const current = await getDashboardPage({ pageId: page.id });
  const nextIndex = current.page.widgets.length;
  const widget: DashboardWidgetLayoutDTO = {
    id: `widget_${Date.now().toString(36)}`,
    viewId: created.view.id,
    titleOverride: draft.title,
    grid: {
      x: (nextIndex % 2) * 6,
      y: Math.floor(nextIndex / 2) * 2,
      w: 6,
      h: draft.viewType === "kpi" ? 1 : 2,
    },
  };
  await saveDashboardPageLayout({
    pageId: page.id,
    widgets: [...current.page.widgets, widget],
  });
  return { pageId: page.id };
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
