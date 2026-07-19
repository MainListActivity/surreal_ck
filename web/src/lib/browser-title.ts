import type { Route, WorkspacePage } from "./route";

const BRAND = "卯豆";

const WORKSPACE_PAGE_TITLES: Record<Exclude<WorkspacePage, "home">, string> = {
  docs: "我的文档",
  templates: "模板库",
  dashboard: "仪表盘",
  admin: "工作区设置",
  "admin-console": "SQL 控制台",
  settings: "个人设置",
  trash: "回收站",
};

export type BrowserTitleInput = {
  route: Route;
  workspaceSlug?: string | null;
  workspaceName?: string | null;
  loadedWorkbookId?: string | null;
  workbookName?: string | null;
  activeSheetId?: string | null;
  sheetName?: string | null;
  dashboardWorkbookId?: string | null;
  dashboardTitle?: string | null;
  editorPageKind?: "sheet" | "dashboard";
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function title(...parts: Array<string | null | undefined>): string {
  return [...parts.map(clean).filter((part): part is string => part !== null), BRAND].join(" - ");
}

/**
 * 统一生成浏览器标签页标题。路由负责页面语义，store 中已经加载的展示名负责补充上下文；
 * 永不把 SurrealDB record id 当作面向用户的标题兜底。
 */
export function buildBrowserTitle(input: BrowserTitleInput): string {
  const { route } = input;

  if (route.kind === "home") return BRAND;
  if (route.kind === "login") return title("登录");
  if (route.kind === "callback") return title("正在登录");
  if (route.kind === "form") return title("公开表单");
  if (route.kind === "form-success") return title("提交成功");

  const workspaceMatchesRoute = input.workspaceSlug === undefined || input.workspaceSlug === route.slug;
  const workspaceName = (workspaceMatchesRoute ? clean(input.workspaceName) : null) ?? route.slug;

  if (route.kind === "workspace") {
    if (route.page === "home") return title(workspaceName);
    return title(WORKSPACE_PAGE_TITLES[route.page], workspaceName);
  }

  const workbookMatchesRoute = input.loadedWorkbookId === undefined
    || input.loadedWorkbookId === route.workbookId;
  const workbookName = workbookMatchesRoute ? clean(input.workbookName) : null;
  if (input.editorPageKind === "dashboard") {
    const dashboardMatchesWorkbook = input.dashboardWorkbookId === undefined
      || input.dashboardWorkbookId === route.workbookId;
    return workbookName && dashboardMatchesWorkbook
      ? title(clean(input.dashboardTitle) ?? "仪表盘", workbookName)
      : title("工作簿", workspaceName);
  }

  const sheetMatchesRoute = route.sheetId === null
    || input.activeSheetId === undefined
    || input.activeSheetId === route.sheetId;
  if (workbookName) return title(sheetMatchesRoute ? clean(input.sheetName) : null, workbookName);
  return title("工作簿", workspaceName);
}
