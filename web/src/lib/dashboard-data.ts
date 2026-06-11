import type {
  DashboardBuilderSpec,
  DashboardViewType,
} from "@surreal-ck/shared/rpc.types";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";
import { describeWriteError, type SaveResult } from "./workbook-data";

/**
 * 内嵌进 `dashboard_page.widgets[]` 的单个 widget。`spec` / `viewType` 复用 shared
 * 的 builder 合约——与 D3-02 聚合编译器、AI `dashboard-draft` 草稿同口径，
 * 不存在第二套 widget 描述。legacy 的独立 `dashboard_view` 表与后端缓存已退役。
 */
export type DashboardWidget = {
  id: string;
  title: string;
  viewType: DashboardViewType;
  spec: DashboardBuilderSpec;
  grid: { x: number; y: number; w: number; h: number };
  display?: Record<string, unknown>;
};

/** dashboard_page 行的列表摘要；记录 id 在内存中以 string 流转。 */
export type DashboardPageSummary = {
  id: string;
  title: string;
  slug: string;
  workbookId?: string;
  description?: string;
  updatedAt?: string;
};

/** 列表作用域：给 workbookId 列该 workbook 的页，不给则列 workspace 级（workbook IS NONE）的页。 */
export type DashboardPageScope = {
  workbookId?: string;
};

/**
 * 直连 SurrealDB 列出 dashboard 页。跨 workspace 隔离由 db 边界保证，
 * 行级可见性由表 PERMISSIONS 兜底——查询不携带任何 auth 过滤。
 */
export async function listDashboardPages(
  conn: SurrealConn,
  scope: DashboardPageScope,
): Promise<DashboardPageSummary[]> {
  const where = scope.workbookId ? "workbook = $wb" : "workbook IS NONE";
  const bindings = scope.workbookId ? { wb: toRecordId(scope.workbookId) } : {};
  const records = await conn.query<Record<string, unknown>>(
    `SELECT * FROM dashboard_page WHERE ${where} ORDER BY updated_at DESC`,
    bindings,
  );
  return records.map(toSummary);
}

/** dashboard_page 整行：summary + 内嵌 widgets。 */
export type DashboardPage = DashboardPageSummary & {
  widgets: DashboardWidget[];
};

/**
 * 直连读取单个 dashboard 页（含 widgets）。`pageId` 是 RecordId 字符串，
 * 在 SDK 边界包成 StringRecordId；不存在（或无 select 权限）时返回 null。
 */
export async function loadDashboardPage(
  conn: SurrealConn,
  pageId: string,
): Promise<DashboardPage | null> {
  const records = await conn.query<Record<string, unknown>>("SELECT * FROM $page", {
    page: toRecordId(pageId),
  });
  const record = records[0];
  return record ? toPage(record) : null;
}

export type DashboardPageResult =
  | { ok: true; page: DashboardPage }
  | { ok: false; message: string };

export type CreateDashboardPageInput = {
  title: string;
  workbookId?: string;
  description?: string;
};

/**
 * 直连创建 dashboard 页。slug 由 title 派生（派生不出拉丁 slug 时回退随机后缀），
 * 撞 `(workbook, slug)` 唯一索引时翻译成可读错误。create 权限由表 PERMISSIONS
 * 兜底（仅管理员）——引擎拒绝时同样以 `{ ok:false }` 返回，不在前端预判 is_admin。
 */
export async function createDashboardPage(
  conn: SurrealConn,
  input: CreateDashboardPageInput,
): Promise<DashboardPageResult> {
  const data: Record<string, unknown> = {
    title: input.title,
    slug: deriveSlug(input.title),
    widgets: [],
    ...(input.workbookId ? { workbook: toRecordId(input.workbookId) } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
  try {
    const record = await conn.createRecord("dashboard_page", data);
    return { ok: true, page: toPage(record) };
  } catch (err) {
    return { ok: false, message: describeDashboardWriteError(err) };
  }
}

/**
 * 直连改名 dashboard 页：MERGE 只更新 title，**slug 保持稳定**——slug 进了路由/链接，
 * 改名不应让既有链接漂移（legacy 后端改名会重派生 slug，此行为不延续）。
 */
export function renameDashboardPage(
  conn: SurrealConn,
  pageId: string,
  title: string,
): Promise<DashboardPageResult> {
  return mergePage(conn, pageId, { title });
}

/**
 * 直连整组覆盖一个页的 widgets——新增、删除、改布局的统一入口（与 legacy
 * `saveDashboardPageLayout` 同语义）。widget 配置内嵌存储，原样写入。
 */
export function saveDashboardPageWidgets(
  conn: SurrealConn,
  pageId: string,
  widgets: DashboardWidget[],
): Promise<DashboardPageResult> {
  return mergePage(conn, pageId, { widgets });
}

/** 直连删除 dashboard 页。delete 权限由表 PERMISSIONS 兜底（仅管理员）。 */
export async function deleteDashboardPage(
  conn: SurrealConn,
  pageId: string,
): Promise<SaveResult> {
  try {
    await conn.deleteRecord(pageId);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: describeDashboardWriteError(err) };
  }
}

/** MERGE 单页若干字段并映射回 DTO；写权限由表 PERMISSIONS 兜底，错误统一翻译。 */
async function mergePage(
  conn: SurrealConn,
  pageId: string,
  patch: Record<string, unknown>,
): Promise<DashboardPageResult> {
  try {
    const record = await conn.updateRecord(pageId, patch);
    return { ok: true, page: toPage(record) };
  } catch (err) {
    return { ok: false, message: describeDashboardWriteError(err) };
  }
}

/** title → kebab slug；中文等派生为空时回退 `page-` + 随机 base36 后缀。 */
function deriveSlug(title: string): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || `page-${Math.random().toString(36).slice(2, 8)}`;
}

function describeDashboardWriteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/dashboard_page_slug_unique/.test(message)) {
    return "同名仪表盘页已存在，请换一个标题";
  }
  if (/permission|not allowed|IAM/i.test(message)) {
    return "没有权限执行该操作（仅工作区管理员可管理仪表盘页）";
  }
  return describeWriteError(err);
}

function toPage(record: Record<string, unknown>): DashboardPage {
  return {
    ...toSummary(record),
    widgets: Array.isArray(record.widgets) ? (record.widgets as DashboardWidget[]) : [],
  };
}

function toSummary(record: Record<string, unknown>): DashboardPageSummary {
  const workbookId = record.workbook ? recordValueToString(record.workbook) : undefined;
  return {
    id: String(record.id),
    title: String(record.title),
    slug: String(record.slug),
    ...(typeof workbookId === "string" ? { workbookId } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(record.updated_at instanceof Date ? { updatedAt: record.updated_at.toISOString() } : {}),
  };
}
