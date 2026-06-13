import { filterWorkbooksByQuery, type WorkbookRow } from "./workbooks";
import type { ConnectionState } from "./workspace-store";

export type WorkbookHomeTab = "all" | "mine" | "shared";
export type WorkbookViewMode = "grid" | "list";
export type WorkbookPreviewKind = "table" | "graph" | "blank";

export const WORKBOOK_VIEW_MODE_STORAGE_KEY = "surreal_ck.workbook_view_mode";

export type WorkbookViewModeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
};

export type WorkbookCardPresentation = {
  previewKind: WorkbookPreviewKind;
  statusLabel: string;
  templateLabel: string;
};

export type ConnectionDotPresentation = {
  label: "已连接" | "已断开";
  tone: "connected" | "disconnected";
};

export type WorkbookHomeFilter = {
  query: string;
  tab: WorkbookHomeTab;
  currentUserId?: string;
};

export function filterHomeWorkbooks(workbooks: WorkbookRow[], filter: WorkbookHomeFilter): WorkbookRow[] {
  const searched = filterWorkbooksByQuery(workbooks, filter.query);
  if (filter.tab === "all") return searched;
  if (filter.tab === "shared") return [];
  if (!filter.currentUserId) return [];
  return searched.filter((wb) => wb.createdBy === filter.currentUserId);
}

export function readWorkbookViewMode(storage?: WorkbookViewModeStorage | null): WorkbookViewMode {
  const value = storage?.getItem(WORKBOOK_VIEW_MODE_STORAGE_KEY);
  return value === "list" ? "list" : "grid";
}

export function writeWorkbookViewMode(storage: WorkbookViewModeStorage | undefined | null, mode: WorkbookViewMode): void {
  storage?.setItem(WORKBOOK_VIEW_MODE_STORAGE_KEY, mode);
}

export function formatWorkbookUpdatedAt(value: string | undefined, now: Date = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return "—";

  const diffMs = Math.max(0, now.getTime() - time);
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startToday - startDate) / 86400000);
  if (dayDiff === 1) return "昨天";

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} 小时前`;
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export function workbookCardPresentation(templateKey: string | undefined): WorkbookCardPresentation {
  const key = templateKey?.toLowerCase() ?? "";
  if (["graph", "network", "relations", "relationship"].includes(key)) {
    return { previewKind: "graph", statusLabel: "待审核", templateLabel: "关系图谱" };
  }
  if (["claims", "claim", "finance", "table", "ledger"].includes(key)) {
    return {
      previewKind: "table",
      statusLabel: key === "finance" ? "待审核" : "进行中",
      templateLabel: key === "finance" ? "财务汇总" : "债权台账",
    };
  }
  return { previewKind: "blank", statusLabel: "草稿", templateLabel: "空白工作簿" };
}

export function homeGreetingForDate(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function connectionDotPresentation(state: ConnectionState): ConnectionDotPresentation {
  if (state === "open") return { label: "已连接", tone: "connected" };
  return { label: "已断开", tone: "disconnected" };
}
