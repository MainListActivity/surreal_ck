import type { WorkbookTemplate } from "@surreal-ck/shared/rpc.types";
import { filterWorkbooksByQuery, type WorkbookRow } from "./workbooks";
import type { ConnectionState } from "./workspace-store";

export type PinnedWorkbooksStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
};

export type WorkbookHomeTab = "all" | "mine" | "shared";
export type WorkbookViewMode = "grid" | "list";
export type WorkbookPreviewKind = "table" | "graph" | "blank";

export const WORKBOOK_VIEW_MODE_STORAGE_KEY = "surreal_ck.workbook_view_mode";

export type WorkbookViewModeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
};

/**
 * 卡片展示 = 工作簿类型(模板)派生而来。类型语义只有一份真相，在 `workbook_template`
 * 数据里；这里只做「模板 → 视觉」的解析，无模板回退到空白工作簿。
 *
 * 状态（草稿 / 进行中 / 已发布）是另一条正交轴，由后续需求实现——本类型刻意不含
 * statusLabel，避免再把类型和状态揉成一团。
 */
export type WorkbookCardPresentation = {
  previewKind: WorkbookPreviewKind;
  templateLabel: string;
  /** lucide 图标名（来自模板 icon）；无则用 previewKind 内置 svg mark。 */
  icon?: string;
  accent: string;
  soft: string;
};

/** previewKind → 内置 svg mark 的兜底配色（无模板 / 模板无 accent 时用）。 */
const PREVIEW_TONE: Record<WorkbookPreviewKind, { accent: string; soft: string }> = {
  table: { accent: "#2F7A4C", soft: "#E7F0E4" },
  graph: { accent: "#CC6B3A", soft: "#F7E7DA" },
  blank: { accent: "#8C8472", soft: "#ECE7DB" },
};

/** 把 hex 强调色淡化成卡片背景（soft）：直接退回 previewKind 的内置 soft 即可，避免引色彩库。 */
function softFor(previewKind: WorkbookPreviewKind): string {
  return PREVIEW_TONE[previewKind].soft;
}

/** 模板 icon 名 → previewKind（决定无 icon 时的 svg mark 与兜底配色）。 */
function previewKindForTemplate(template: WorkbookTemplate | undefined): WorkbookPreviewKind {
  if (!template) return "blank";
  if (["network", "relations", "graph", "git-fork"].includes(template.icon ?? "")) return "graph";
  return "table";
}

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

/**
 * 卡片展示从工作簿解析到的业务模板派生：模板的 icon / accent / label 直接驱动渲染，
 * 解析不到模板（templateRef 为空，或模板已被删）= 空白工作簿。
 * 不再用字符串硬猜，也不在这里造类型语义——类型只活在 workbook_template 数据里。
 */
export function workbookCardPresentation(template: WorkbookTemplate | undefined): WorkbookCardPresentation {
  if (!template) {
    return {
      previewKind: "blank",
      templateLabel: "空白工作簿",
      accent: PREVIEW_TONE.blank.accent,
      soft: PREVIEW_TONE.blank.soft,
    };
  }
  const previewKind = previewKindForTemplate(template);
  return {
    previewKind,
    templateLabel: template.label || "未命名类型",
    icon: template.icon,
    accent: template.accent || PREVIEW_TONE[previewKind].accent,
    soft: softFor(previewKind),
  };
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

export const PINNED_WORKBOOKS_STORAGE_KEY_PREFIX = "surreal_ck.pinned_workbooks.";

export function getPinnedStorageKey(dbName: string): string {
  return `${PINNED_WORKBOOKS_STORAGE_KEY_PREFIX}${dbName}`;
}

export function readPinnedWorkbooks(storage: PinnedWorkbooksStorage | null | undefined, dbName: string): string[] {
  const raw = storage?.getItem(getPinnedStorageKey(dbName));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

export function writePinnedWorkbooks(storage: PinnedWorkbooksStorage | null | undefined, dbName: string, ids: string[]): void {
  storage?.setItem(getPinnedStorageKey(dbName), JSON.stringify(ids));
}

export function pinWorkbook(storage: PinnedWorkbooksStorage | null | undefined, dbName: string, id: string): string[] {
  const current = readPinnedWorkbooks(storage, dbName);
  if (current.includes(id)) return current;
  const updated = [...current, id];
  writePinnedWorkbooks(storage, dbName, updated);
  return updated;
}
