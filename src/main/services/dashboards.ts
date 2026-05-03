import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanReadWorkspace, assertCanWriteWorkspace, getCurrentUserRecordId } from "./context";
import { ServiceError } from "./errors";
import { compileDashboardBuilder } from "./dashboard-builder";
import { runDashboardPreview, toDashboardCacheDTO } from "./dashboard-query";
import type {
  CreateDashboardPageRequest,
  CreateDashboardPageResponse,
  CreateDashboardViewRequest,
  CreateDashboardViewResponse,
  DashboardCacheDTO,
  DashboardPageDTO,
  DashboardPageSummaryDTO,
  DashboardPreviewResponse,
  DashboardViewDTO,
  DashboardViewDraftDTO,
  DashboardViewSummaryDTO,
  GetDashboardPageRequest,
  GetDashboardPageResponse,
  ListDashboardPagesRequest,
  ListDashboardPagesResponse,
  ListDashboardViewsRequest,
  ListDashboardViewsResponse,
  RefreshDashboardPageRequest,
  RefreshDashboardPageResponse,
  RefreshDashboardViewRequest,
  RefreshDashboardViewResponse,
  RecordIdString,
  SaveDashboardPageLayoutRequest,
  SaveDashboardPageLayoutResponse,
  UpdateDashboardViewRequest,
  UpdateDashboardViewResponse,
} from "../../shared/rpc.types";

type DashboardPageRow = {
  id: RecordId;
  workspace: RecordId;
  workbook?: RecordId;
  title: string;
  slug: string;
  description?: string;
  widgets?: unknown[];
  updated_at?: Date;
};

type DashboardViewRow = {
  id: RecordId;
  workspace: RecordId;
  workbook?: RecordId;
  title: string;
  slug: string;
  description?: string;
  query_mode: DashboardViewDTO["queryMode"];
  view_type: DashboardViewDTO["viewType"];
  result_contract: DashboardViewDTO["resultContract"];
  compiled_sql: string;
  status: DashboardViewDTO["status"];
  version: number;
  created_by?: RecordId;
  source_tables?: string[];
  dependencies?: string[];
  builder_spec?: DashboardViewDTO["builderSpec"];
  display_spec?: DashboardViewDTO["displaySpec"];
  last_run_at?: Date;
  updated_at?: Date;
};

type DashboardCacheRow = {
  id: RecordId;
  view: RecordId;
  status: DashboardCacheDTO["status"];
  rows_count: number;
  duration_ms: number;
  executed_at?: Date;
  sql_hash: string;
  result_json?: unknown;
  result_meta?: Record<string, unknown>;
  error_detail?: unknown;
};

export async function listDashboardPages({
  workspaceId,
  workbookId,
}: ListDashboardPagesRequest): Promise<ListDashboardPagesResponse> {
  await assertCanReadWorkspace(workspaceId);
  await assertWorkbookScope(workspaceId, workbookId);
  const db = getLocalDb();
  const sql = workbookId
    ? `SELECT id, workspace, workbook, title, slug, description, updated_at
       FROM dashboard_page
       WHERE workspace = $workspaceId
         AND workbook = $workbookId
       ORDER BY updated_at DESC, created_at DESC`
    : `SELECT id, workspace, workbook, title, slug, description, updated_at
       FROM dashboard_page
       WHERE workspace = $workspaceId
         AND (workbook = NONE OR workbook = NULL)
       ORDER BY updated_at DESC, created_at DESC`;
  const rows = await db.query<[DashboardPageRow[]]>(
    sql,
    workbookId
      ? { workspaceId: new StringRecordId(workspaceId), workbookId: new StringRecordId(workbookId) }
      : { workspaceId: new StringRecordId(workspaceId) },
  );
  return { pages: (rows[0] ?? []).map(pageRowToSummaryDTO) };
}

export async function createDashboardPage({
  workspaceId,
  workbookId,
  title,
  description,
}: CreateDashboardPageRequest): Promise<CreateDashboardPageResponse> {
  await assertCanWriteWorkspace(workspaceId);
  await assertWorkbookScope(workspaceId, workbookId);
  const trimmed = title.trim();
  if (!trimmed) throw new ServiceError("VALIDATION_ERROR", "仪表盘名称不能为空");

  const db = getLocalDb();
  const pageKey = randomHex(`dashboard_page:${workspaceId}:${trimmed}`);
  const pageId = new RecordId("dashboard_page", pageKey);
  const slug = slugify(trimmed, pageKey.slice(0, 6));
  await db.query(
    `UPSERT $pageId CONTENT {
      workspace: $workspaceId,
      workbook: $workbookId,
      title: $title,
      slug: $slug,
      description: $description,
      widgets: [],
      updated_at: time::now()
    }`,
    {
      pageId,
      workspaceId: new StringRecordId(workspaceId),
      workbookId: workbookId ? new StringRecordId(workbookId) : null,
      title: trimmed,
      slug,
      description: description?.trim() || null,
    },
  );

  const rows = await db.query<[DashboardPageRow[]]>(
    `SELECT id, workspace, workbook, title, slug, description, widgets, updated_at FROM dashboard_page WHERE id = $pageId LIMIT 1`,
    { pageId },
  );
  const row = rows[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "仪表盘页面创建失败");
  return { page: pageRowToDTO(row) };
}

export async function getDashboardPage({
  pageId,
}: GetDashboardPageRequest): Promise<GetDashboardPageResponse> {
  const page = await loadDashboardPage(pageId);
  await assertCanReadWorkspace(page.workspaceId);
  const widgetViewIds = Array.from(new Set(page.widgets.map((widget) => widget.viewId)));
  const views = await Promise.all(widgetViewIds.map((id) => loadDashboardView(id)));
  const caches = await Promise.all(widgetViewIds.map((id) => loadDashboardCacheByView(id)));
  return {
    page,
    views: views.filter((item): item is DashboardViewDTO => Boolean(item)),
    caches: caches.filter((item): item is DashboardCacheDTO => Boolean(item)),
  };
}

export async function saveDashboardPageLayout({
  pageId,
  widgets,
}: SaveDashboardPageLayoutRequest): Promise<SaveDashboardPageLayoutResponse> {
  const page = await loadDashboardPage(pageId);
  await assertCanWriteWorkspace(page.workspaceId);

  for (const widget of widgets) {
    if (!widget.id || !widget.viewId) {
      throw new ServiceError("VALIDATION_ERROR", "无效的 widget 定义");
    }
    await ensureDashboardViewExists(widget.viewId, page.workspaceId, page.workbookId);
  }

  const db = getLocalDb();
  const updated = await db.query<[DashboardPageRow[]]>(
    `UPDATE $pageId SET widgets = $widgets, updated_at = time::now()
     RETURN id, workspace, workbook, title, slug, description, widgets, updated_at`,
    {
      pageId: new StringRecordId(pageId),
      widgets,
    },
  );
  const row = updated[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "保存仪表盘布局失败");
  return { page: pageRowToDTO(row) };
}

export async function listDashboardViews({
  workspaceId,
  workbookId,
}: ListDashboardViewsRequest): Promise<ListDashboardViewsResponse> {
  await assertCanReadWorkspace(workspaceId);
  await assertWorkbookScope(workspaceId, workbookId);
  const db = getLocalDb();
  const sql = workbookId
    ? `SELECT id, workspace, workbook, title, slug, description, query_mode, view_type, result_contract,
              compiled_sql, status, version, created_by, source_tables, dependencies,
              builder_spec, display_spec, last_run_at, updated_at
       FROM dashboard_view
       WHERE workspace = $workspaceId
         AND workbook = $workbookId
       ORDER BY updated_at DESC, created_at DESC`
    : `SELECT id, workspace, workbook, title, slug, description, query_mode, view_type, result_contract,
              compiled_sql, status, version, created_by, source_tables, dependencies,
              builder_spec, display_spec, last_run_at, updated_at
       FROM dashboard_view
       WHERE workspace = $workspaceId
         AND (workbook = NONE OR workbook = NULL)
       ORDER BY updated_at DESC, created_at DESC`;
  const rows = await db.query<[DashboardViewRow[]]>(
    sql,
    workbookId
      ? { workspaceId: new StringRecordId(workspaceId), workbookId: new StringRecordId(workbookId) }
      : { workspaceId: new StringRecordId(workspaceId) },
  );
  return { views: (rows[0] ?? []).map(viewRowToSummaryDTO) };
}

export async function createDashboardView({
  draft,
}: CreateDashboardViewRequest): Promise<CreateDashboardViewResponse> {
  await assertCanWriteWorkspace(draft.workspaceId);
  await assertWorkbookScope(draft.workspaceId, draft.workbookId);
  const preview = await previewDraft(draft);
  const db = getLocalDb();
  const viewKey = randomHex(`dashboard_view:${draft.workspaceId}:${draft.title}`);
  const viewId = new RecordId("dashboard_view", viewKey);
  const createdBy = await getCurrentUserRecordId();
  const normalized = normalizeDraft(draft, preview, viewKey.slice(0, 6));

  await db.query(
    `UPSERT $viewId CONTENT {
      workspace: $workspaceId,
      workbook: $workbookId,
      title: $title,
      slug: $slug,
      description: $description,
      query_mode: $queryMode,
      view_type: $viewType,
      result_contract: $resultContract,
      compiled_sql: $compiledSql,
      status: $status,
      version: 1,
      created_by: $createdBy,
      source_tables: $sourceTables,
      dependencies: $dependencies,
      builder_spec: $builderSpec,
      display_spec: $displaySpec,
      last_run_at: time::now(),
      updated_at: time::now()
    }`,
    {
      viewId,
      workspaceId: new StringRecordId(draft.workspaceId),
      workbookId: draft.workbookId ? new StringRecordId(draft.workbookId) : null,
      title: normalized.title,
      slug: normalized.slug,
      description: normalized.description,
      queryMode: normalized.queryMode,
      viewType: normalized.viewType,
      resultContract: normalized.resultContract,
      compiledSql: preview.sql,
      status: normalized.status,
      createdBy,
      sourceTables: preview.sourceTables,
      dependencies: preview.dependencies,
      builderSpec: normalized.builderSpec ?? {},
      displaySpec: normalized.displaySpec ?? {},
    },
  );

  const cache = await upsertDashboardCache(String(viewId), preview);
  const view = await mustLoadDashboardView(String(viewId));
  return { view, cache };
}

export async function updateDashboardView({
  viewId,
  draft,
}: UpdateDashboardViewRequest): Promise<UpdateDashboardViewResponse> {
  const current = await mustLoadDashboardView(viewId);
  await assertCanWriteWorkspace(current.workspaceId);
  const mergedDraft: DashboardViewDraftDTO = {
    workspaceId: current.workspaceId,
    workbookId: draft.workbookId ?? current.workbookId,
    title: draft.title || current.title,
    slug: draft.slug || current.slug,
    description: draft.description ?? current.description,
    queryMode: draft.queryMode,
    viewType: draft.viewType,
    resultContract: draft.resultContract,
    compiledSql: draft.compiledSql ?? current.compiledSql,
    builderSpec: draft.builderSpec ?? current.builderSpec,
    displaySpec: draft.displaySpec ?? current.displaySpec,
    status: draft.status ?? current.status,
  };
  const preview = await previewDraft(mergedDraft);
  const normalized = normalizeDraft(mergedDraft, preview);

  const db = getLocalDb();
  await db.query(
    `UPDATE $viewId SET
      title = $title,
      slug = $slug,
      description = $description,
      workbook = $workbookId,
      query_mode = $queryMode,
      view_type = $viewType,
      result_contract = $resultContract,
      compiled_sql = $compiledSql,
      status = $status,
      version += 1,
      source_tables = $sourceTables,
      dependencies = $dependencies,
      builder_spec = $builderSpec,
      display_spec = $displaySpec,
      last_run_at = time::now(),
      updated_at = time::now()`,
    {
      viewId: new StringRecordId(viewId),
      title: normalized.title,
      slug: normalized.slug,
      description: normalized.description,
      workbookId: normalized.workbookId ? new StringRecordId(normalized.workbookId) : null,
      queryMode: normalized.queryMode,
      viewType: normalized.viewType,
      resultContract: normalized.resultContract,
      compiledSql: preview.sql,
      status: normalized.status,
      sourceTables: preview.sourceTables,
      dependencies: preview.dependencies,
      builderSpec: normalized.builderSpec ?? {},
      displaySpec: normalized.displaySpec ?? {},
    },
  );

  const cache = await upsertDashboardCache(viewId, preview);
  const view = await mustLoadDashboardView(viewId);
  return { view, cache };
}

export async function refreshDashboardView({
  viewId,
}: RefreshDashboardViewRequest): Promise<RefreshDashboardViewResponse> {
  const view = await mustLoadDashboardView(viewId);
  await assertCanReadWorkspace(view.workspaceId);
  const preview = await runDashboardPreview(view.compiledSql, view.resultContract, view.displaySpec ?? {});
  const cache = await upsertDashboardCache(viewId, preview);
  const db = getLocalDb();
  await db.query(
    `UPDATE $viewId SET last_run_at = time::now(), updated_at = time::now()`,
    { viewId: new StringRecordId(viewId) },
  );
  return { cache };
}

export async function refreshDashboardPage({
  pageId,
}: RefreshDashboardPageRequest): Promise<RefreshDashboardPageResponse> {
  const page = await loadDashboardPage(pageId);
  await assertCanReadWorkspace(page.workspaceId);
  const caches: DashboardCacheDTO[] = [];
  const viewIds = Array.from(new Set(page.widgets.map((widget) => widget.viewId)));
  for (const viewId of viewIds) {
    const refreshed = await refreshDashboardView({ viewId });
    caches.push(refreshed.cache);
  }
  return { caches };
}

export async function previewDashboardDraft(
  draft: DashboardViewDraftDTO,
): Promise<DashboardPreviewResponse> {
  await assertCanReadWorkspace(draft.workspaceId);
  await assertWorkbookScope(draft.workspaceId, draft.workbookId);
  return previewDraft(draft);
}

async function previewDraft(draft: DashboardViewDraftDTO): Promise<DashboardPreviewResponse> {
  if (!draft.title?.trim()) throw new ServiceError("VALIDATION_ERROR", "视图名称不能为空");

  if (draft.queryMode === "builder") {
    if (!draft.builderSpec) {
      throw new ServiceError("VALIDATION_ERROR", "Builder 模式缺少配置");
    }
    const compiled = compileDashboardBuilder(draft.builderSpec);
    return runDashboardPreview(compiled.sql, compiled.resultContract, {
      ...(compiled.displaySpec ?? {}),
      ...(draft.displaySpec ?? {}),
    });
  }

  const compiledSql = draft.compiledSql?.trim();
  if (!compiledSql) throw new ServiceError("VALIDATION_ERROR", "SQL 不能为空");
  return runDashboardPreview(compiledSql, draft.resultContract, draft.displaySpec ?? {});
}

async function upsertDashboardCache(viewId: string, preview: DashboardPreviewResponse): Promise<DashboardCacheDTO> {
  const db = getLocalDb();
  const cacheId = new RecordId("dashboard_result_cache", recordKey(viewId));
  const cache = toDashboardCacheDTO(viewId, preview);
  await db.query(
    `UPSERT $cacheId CONTENT {
      view: $viewId,
      status: $status,
      rows_count: $rowsCount,
      duration_ms: $durationMs,
      executed_at: $executedAt,
      sql_hash: $sqlHash,
      result_json: $result,
      result_meta: $resultMeta,
      error_detail: $errorDetail
    }`,
    {
      cacheId,
      viewId: new StringRecordId(viewId),
      status: cache.status,
      rowsCount: cache.rowsCount,
      durationMs: cache.durationMs,
      executedAt: new Date(cache.executedAt ?? new Date().toISOString()),
      sqlHash: cache.sqlHash,
      result: cache.result ?? null,
      resultMeta: cache.resultMeta ?? {},
      errorDetail: cache.errorDetail ?? null,
    },
  );
  return cache;
}

async function loadDashboardPage(pageId: string): Promise<DashboardPageDTO> {
  const db = getLocalDb();
  const rows = await db.query<[DashboardPageRow[]]>(
    `SELECT id, workspace, workbook, title, slug, description, widgets, updated_at
     FROM dashboard_page
     WHERE id = $pageId
     LIMIT 1`,
    { pageId: new StringRecordId(pageId) },
  );
  const row = rows[0]?.[0];
  if (!row) throw new ServiceError("NOT_FOUND", "仪表盘页面不存在");
  return pageRowToDTO(row);
}

async function loadDashboardView(viewId: string): Promise<DashboardViewDTO | null> {
  const db = getLocalDb();
  const rows = await db.query<[DashboardViewRow[]]>(
    `SELECT id, workspace, workbook, title, slug, description, query_mode, view_type, result_contract,
            compiled_sql, status, version, created_by, source_tables, dependencies,
            builder_spec, display_spec, last_run_at, updated_at
     FROM dashboard_view
     WHERE id = $viewId
     LIMIT 1`,
    { viewId: new StringRecordId(viewId) },
  );
  const row = rows[0]?.[0];
  return row ? viewRowToDTO(row) : null;
}

async function mustLoadDashboardView(viewId: string): Promise<DashboardViewDTO> {
  const row = await loadDashboardView(viewId);
  if (!row) throw new ServiceError("NOT_FOUND", "仪表盘视图不存在");
  return row;
}

async function ensureDashboardViewExists(viewId: string, workspaceId: string, workbookId?: string): Promise<void> {
  const view = await mustLoadDashboardView(viewId);
  if (view.workspaceId !== workspaceId) {
    throw new ServiceError("VALIDATION_ERROR", "不能跨工作区引用仪表盘视图");
  }
  if ((view.workbookId ?? undefined) !== (workbookId ?? undefined)) {
    throw new ServiceError("VALIDATION_ERROR", "不能跨工作簿引用仪表盘视图");
  }
}

async function assertWorkbookScope(workspaceId: string, workbookId?: string): Promise<void> {
  if (!workbookId) return;
  const db = getLocalDb();
  const rows = await db.query<[{ id: RecordId; workspace: RecordId }[]]>(
    `SELECT id, workspace FROM workbook WHERE id = $workbookId LIMIT 1`,
    { workbookId: new StringRecordId(workbookId) },
  );
  const workbook = rows[0]?.[0];
  if (!workbook) throw new ServiceError("NOT_FOUND", "工作簿不存在");
  if (String(workbook.workspace) !== workspaceId) {
    throw new ServiceError("VALIDATION_ERROR", "仪表盘工作簿与工作区不匹配");
  }
}

async function loadDashboardCacheByView(viewId: string): Promise<DashboardCacheDTO | null> {
  const db = getLocalDb();
  const rows = await db.query<[DashboardCacheRow[]]>(
    `SELECT id, view, status, rows_count, duration_ms, executed_at, sql_hash, result_json, result_meta, error_detail
     FROM dashboard_result_cache
     WHERE view = $viewId
     LIMIT 1`,
    { viewId: new StringRecordId(viewId) },
  );
  const row = rows[0]?.[0];
  return row ? cacheRowToDTO(row) : null;
}

function normalizeDraft(
  draft: DashboardViewDraftDTO,
  preview: DashboardPreviewResponse,
  slugSuffix = "",
): DashboardViewDraftDTO {
  const title = draft.title.trim();
  return {
    ...draft,
    title,
    slug: draft.slug?.trim() || slugify(title, slugSuffix || preview.sqlHash.slice(0, 6)),
    description: draft.description?.trim() || undefined,
    viewType: draft.queryMode === "builder"
      ? inferBuilderViewType(draft, preview)
      : draft.viewType,
    resultContract: draft.queryMode === "builder"
      ? inferBuilderContract(draft, preview)
      : draft.resultContract,
    compiledSql: preview.sql,
    status: draft.status ?? "active",
  };
}

function inferBuilderViewType(draft: DashboardViewDraftDTO, preview: DashboardPreviewResponse): DashboardViewDTO["viewType"] {
  if (draft.viewType) return draft.viewType;
  if ("columns" in preview.result) return "table";
  if ("rows" in preview.result && preview.result.rows[0] && "x" in preview.result.rows[0]) return "line";
  if ("rows" in preview.result) return "bar";
  return "kpi";
}

function inferBuilderContract(draft: DashboardViewDraftDTO, preview: DashboardPreviewResponse): DashboardViewDTO["resultContract"] {
  if (draft.resultContract) return draft.resultContract;
  if ("columns" in preview.result) return "table_rows";
  if ("rows" in preview.result && preview.result.rows[0] && "x" in preview.result.rows[0]) return "time_series";
  if ("rows" in preview.result) return "category_breakdown";
  return "single_value";
}

function pageRowToSummaryDTO(row: DashboardPageRow): DashboardPageSummaryDTO {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace),
    workbookId: row.workbook ? String(row.workbook) : undefined,
    title: row.title,
    slug: row.slug,
    description: row.description,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
  };
}

function pageRowToDTO(row: DashboardPageRow): DashboardPageDTO {
  return {
    ...pageRowToSummaryDTO(row),
    widgets: Array.isArray(row.widgets) ? row.widgets as DashboardPageDTO["widgets"] : [],
  };
}

function viewRowToSummaryDTO(row: DashboardViewRow): DashboardViewSummaryDTO {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace),
    workbookId: row.workbook ? String(row.workbook) : undefined,
    title: row.title,
    slug: row.slug,
    description: row.description,
    queryMode: row.query_mode,
    viewType: row.view_type,
    resultContract: row.result_contract,
    status: row.status,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : undefined,
  };
}

function viewRowToDTO(row: DashboardViewRow): DashboardViewDTO {
  return {
    ...viewRowToSummaryDTO(row),
    compiledSql: row.compiled_sql,
    builderSpec: row.builder_spec,
    displaySpec: row.display_spec ?? {},
    sourceTables: row.source_tables ?? [],
    dependencies: row.dependencies ?? [],
    version: row.version,
    createdBy: row.created_by ? String(row.created_by) : undefined,
  };
}

function cacheRowToDTO(row: DashboardCacheRow): DashboardCacheDTO {
  return {
    viewId: String(row.view),
    status: row.status,
    rowsCount: row.rows_count,
    durationMs: row.duration_ms,
    executedAt: row.executed_at ? row.executed_at.toISOString() : undefined,
    sqlHash: row.sql_hash,
    result: row.result_json as DashboardCacheDTO["result"],
    resultMeta: row.result_meta ?? {},
    errorDetail: row.error_detail,
  };
}

function slugify(title: string, fallbackSuffix: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `dashboard-${fallbackSuffix}`;
}

function randomHex(seed: string): string {
  return Bun.hash.wyhash(`${seed}:${Date.now()}:${Math.random()}`).toString(16).padStart(16, "0");
}

function recordKey(id: RecordIdString): string {
  return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
}
