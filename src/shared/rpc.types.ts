import type { ElectrobunRPCSchema } from "electrobun/bun";

// ─── 传输基础类型 ─────────────────────────────────────────────────────────────

/** SurrealDB record id serialized for transport, e.g. "workspace:abc123". */
export type RecordIdString = string;

/** ISO-8601 datetime string serialized for transport. */
export type ISODateTimeString = string;

// Legacy scaffold channel. Do not use for product APIs.
export type LegacyRowData = {
  id: string;
  name: string;
  value: string;
};

export type RawQueryRequest = {
  sql: string;
};

export type RawQueryResponse = unknown[];

export type AuthState = {
  loggedIn: boolean;
  expiresAt?: number;
  error?: string;
  offlineMode?: boolean;
};

// ─── 错误模型 ──────────────────────────────────────────────────────────────────

export type AppErrorCode =
  | "NOT_AUTHENTICATED"
  | "OFFLINE_READ_ONLY"
  | "NOT_IMPLEMENTED"
  | "BOOTSTRAP_REQUIRED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

export type AppError = {
  ok: false;
  code: AppErrorCode;
  message: string;
};

export type AppOk<T> = {
  ok: true;
  data: T;
};

export type Result<T> = AppOk<T> | AppError;

// ─── 业务 DTO ─────────────────────────────────────────────────────────────────

export type CurrentUserDTO = {
  id: RecordIdString;
  subject: string;
  email?: string;
  name?: string;
  displayName?: string;
  avatar?: string;
};

export type WorkspaceDTO = {
  id: RecordIdString;
  name: string;
  slug: string;
};

export type AppBootstrap = {
  auth: AuthState;
  readOnly: boolean;
  user?: CurrentUserDTO;
  defaultWorkspace?: WorkspaceDTO;
};

export type WorkbookSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  name: string;
  templateKey?: string;
  folderId?: RecordIdString;
  updatedAt?: ISODateTimeString;
};

export type ListWorkbooksRequest = {
  workspaceId: RecordIdString;
  folderId?: RecordIdString | null;
  search?: string;
};

export type ListWorkbooksResponse = {
  workbooks: WorkbookSummaryDTO[];
};

export type CreateBlankWorkbookRequest = {
  workspaceId: RecordIdString;
  name: string;
  folderId?: RecordIdString | null;
};

export type CreateBlankWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

export type FolderDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  name: string;
  parentId?: RecordIdString;
  position: number;
};

export type ListFoldersRequest = {
  workspaceId: RecordIdString;
};

export type ListFoldersResponse = {
  folders: FolderDTO[];
};

export type CreateFolderRequest = {
  workspaceId: RecordIdString;
  name: string;
  parentId?: RecordIdString;
};

export type CreateFolderResponse = {
  folder: FolderDTO;
};

export type MoveFolderRequest = {
  folderId: RecordIdString;
  /** 新的父目录 id；null 表示移到根目录 */
  parentId: RecordIdString | null;
};

export type MoveFolderResponse = {
  folder: FolderDTO;
};

export type MoveWorkbookRequest = {
  workbookId: RecordIdString;
  /** 新的目录 id；null 表示移出目录（未分类） */
  folderId: RecordIdString | null;
};

export type MoveWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

// ─── Template DTOs ────────────────────────────────────────────────────────────

export type TemplateSummaryDTO = {
  key: string;
  name: string;
  description: string;
  tags: string[];
};

export type ListTemplatesResponse = {
  templates: TemplateSummaryDTO[];
};

export type CreateWorkbookFromTemplateRequest = {
  workspaceId: RecordIdString;
  templateKey: string;
  name?: string;
};

export type CreateWorkbookFromTemplateResponse = {
  workbook: WorkbookSummaryDTO;
};

// ─── Editor DTOs ──────────────────────────────────────────────────────────────

export type GridFieldConstraints = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  minDate?: ISODateTimeString;
  maxDate?: ISODateTimeString;
};

export type GridColumnDef = {
  key: string;
  label: string;
  fieldType: string;
  required?: boolean;
  options?: string[];
  constraints?: GridFieldConstraints;
  /** 仅 fieldType === "date" 有效；dayjs 格式串，例如 "YYYY-MM-DD HH:mm:ss"。 */
  dateFormat?: string;
  /** 仅 fieldType === "reference" 有效。目标表名：app_user 或 ent_xxx。建表后不可更换。 */
  referenceTable?: string;
  /** 仅 fieldType === "reference" 且目标为 sheet 时有意义；缓存目标 sheet.id 以便 UI 反查。 */
  referenceSheetId?: RecordIdString;
  /** 仅 fieldType === "reference" 有效。允许多选；默认为 false。 */
  referenceMultiple?: boolean;
  /** 仅 fieldType === "reference" 有效。展示用字段 key；缺省回退到 name → display_name → email → id。 */
  referenceDisplayKey?: string;
};

/** 单个筛选条件。op 决定 value 是否使用、以及如何使用。 */
export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type FilterClause = {
  key: string;
  op: FilterOp;
  /** 对 in：数组；对 contains/eq/...：标量；对 is_null/is_not_null：忽略 */
  value?: unknown;
};

export type SortClause = {
  key: string;
  direction: "asc" | "desc";
};

/** Sheet 视图的查询参数。所有过滤/排序在数据库执行；隐藏与分组在前端展示层。 */
export type ViewParams = {
  filters?: FilterClause[];
  /** 多条件 AND/OR；默认 AND */
  filterMode?: "and" | "or";
  sorts?: SortClause[];
  hiddenFields?: string[];
  groupBy?: string | null;
};

export type GridRow = {
  id: RecordIdString;
  values: Record<string, unknown>;
};

export type SheetSummaryDTO = {
  id: RecordIdString;
  workbookId: RecordIdString;
  univerId: string;
  tableName: string;
  label: string;
  position: number;
  columnDefs: GridColumnDef[];
};

export type WorkbookDataDTO = {
  workbook: WorkbookSummaryDTO;
  sheets: SheetSummaryDTO[];
  activeSheetId: RecordIdString;
  columns: GridColumnDef[];
  rows: GridRow[];
};

export type GetWorkbookDataRequest = {
  workbookId: RecordIdString;
  sheetId?: RecordIdString;
  viewParams?: ViewParams;
};

export type GetWorkbookDataResponse = WorkbookDataDTO;

export type UpsertRowsRequest = {
  sheetId: RecordIdString;
  rows: Array<{ id?: RecordIdString; values: Record<string, unknown> }>;
};

export type UpsertRowsResponse = {
  upserted: GridRow[];
};

export type DeleteRowsRequest = {
  sheetId: RecordIdString;
  ids: RecordIdString[];
};

export type DeleteRowsResponse = {
  deleted: number;
};

export type RenameWorkbookRequest = {
  workbookId: RecordIdString;
  name: string;
};

export type RenameWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

export type UpdateSheetFieldsRequest = {
  sheetId: RecordIdString;
  columns: GridColumnDef[];
};

export type UpdateSheetFieldsResponse = {
  sheet: SheetSummaryDTO;
  columns: GridColumnDef[];
};

export type CreateSheetRequest = {
  workbookId: RecordIdString;
  /** 可选：用户指定的 sheet 名称，缺省时后端按 "Sheet N" 自动生成 */
  label?: string;
};

export type CreateSheetResponse = {
  sheet: SheetSummaryDTO;
};

export type RenameSheetRequest = {
  sheetId: RecordIdString;
  label: string;
};

export type RenameSheetResponse = {
  sheet: SheetSummaryDTO;
};

// ─── Reference DTOs ──────────────────────────────────────────────────────────

/** 一条被引用记录在 UI 中的展示快照（单元格徽章 / 悬停浮窗 / 详情侧栏共用）。 */
export type ReferenceTargetPreview = {
  id: RecordIdString;
  /** "app_user" 或 "ent_xxx"。 */
  table: string;
  /** 仅当 table 是 ent_* 时存在。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 单元格主显示文本，例如 "name 字段值" 或 "Sheet 名 / 主键 id"。 */
  primaryLabel: string;
  /** 当被引用记录已被删除时为 true，UI 渲染为「已删除的记录」。 */
  missing?: boolean;
  /** 浮窗用前 4–6 个字段值；不展示 id / workspace / created_* / updated_* 等系统字段。 */
  preview: Array<{ key: string; label: string; value: unknown }>;
};

export type ResolveReferencesRequest = {
  ids: RecordIdString[];
};

export type ResolveReferencesResponse = {
  items: ReferenceTargetPreview[];
};

export type ReferenceTargetOption = {
  /** 目标表名。 */
  table: string;
  /** UI 用的显示名，例如 "工作簿名 / Sheet 名" 或 "系统：用户"。 */
  label: string;
  /** 仅当 table 是 ent_* 时存在；用于 UI 树状分组与缓存。 */
  workspaceId?: RecordIdString;
  workspaceName?: string;
  workbookId?: RecordIdString;
  workbookName?: string;
  sheetId?: RecordIdString;
  sheetName?: string;
  /** 列出可用作展示字段的列：[{key,label,fieldType}] */
  displayKeys: Array<{ key: string; label: string; fieldType: string }>;
};

export type ListReferenceTargetsResponse = {
  /** 当前用户可访问的所有 sheet + 系统对象。允许跨 workspace。 */
  targets: ReferenceTargetOption[];
};

export type SearchReferenceCandidatesRequest = {
  /** 目标表名：app_user 或 ent_*。 */
  table: string;
  /** 模糊匹配关键词；空串表示返回前 N 条。 */
  query?: string;
  /** 用于决定按哪个字段拼 primaryLabel；缺省回退到 name / display_name / email / id。 */
  displayKey?: string;
  limit?: number;
};

export type SearchReferenceCandidatesResponse = {
  items: ReferenceTargetPreview[];
};

// ─── Dashboard DTOs ──────────────────────────────────────────────────────────

export type DashboardQueryMode = "preset" | "builder" | "sql";
export type DashboardViewType = "kpi" | "table" | "bar" | "line" | "pie" | "area";
export type DashboardResultContract =
  | "single_value"
  | "category_breakdown"
  | "time_series"
  | "table_rows";
export type DashboardViewStatus = "draft" | "active" | "invalid";
export type DashboardCacheStatus = "ok" | "error" | "stale" | "running";
export type DashboardRefreshPolicy = "manual" | "on_open_if_stale" | "interval";

export type DashboardWidgetLayoutDTO = {
  id: string;
  viewId: RecordIdString;
  titleOverride?: string;
  grid: { x: number; y: number; w: number; h: number };
  displayOverride?: Record<string, unknown>;
  refreshPolicyOverride?: "inherit" | DashboardRefreshPolicy;
};

export type DashboardPageSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug: string;
  description?: string;
  updatedAt?: ISODateTimeString;
};

export type DashboardPageDTO = DashboardPageSummaryDTO & {
  widgets: DashboardWidgetLayoutDTO[];
};

export type DashboardBuilderMetricOp =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max";

export type DashboardBuilderFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type DashboardBuilderSpec = {
  sourceTables: string[];
  baseTable: string;
  metric: {
    op: DashboardBuilderMetricOp;
    field?: string;
  };
  dimensions?: Array<{
    field: string;
    bucket?: "day" | "week" | "month" | "year";
  }>;
  filters?: Array<{
    field: string;
    op: DashboardBuilderFilterOp;
    value?: unknown;
  }>;
  sort?: {
    field: string;
    direction: "asc" | "desc";
  };
  limit?: number;
};

export type DashboardViewSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  status: DashboardViewStatus;
  updatedAt?: ISODateTimeString;
  lastRunAt?: ISODateTimeString;
};

export type DashboardViewDTO = DashboardViewSummaryDTO & {
  compiledSql: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  sourceTables: string[];
  dependencies: string[];
  version: number;
  createdBy?: RecordIdString;
};

export type DashboardSingleValueResult = {
  value: number | string | boolean | null;
  label?: string;
  unit?: string;
  delta?: number | null;
};

export type DashboardCategoryBreakdownResult = {
  rows: Array<{ key: string; label: string; value: number }>;
};

export type DashboardTimeSeriesResult = {
  rows: Array<{ x: string; y: number; series?: string }>;
};

export type DashboardTableRowsResult = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
};

export type DashboardNormalizedResult =
  | DashboardSingleValueResult
  | DashboardCategoryBreakdownResult
  | DashboardTimeSeriesResult
  | DashboardTableRowsResult;

export type DashboardCacheDTO = {
  viewId: RecordIdString;
  status: DashboardCacheStatus;
  rowsCount: number;
  durationMs: number;
  executedAt?: ISODateTimeString;
  sqlHash: string;
  result?: DashboardNormalizedResult;
  resultMeta?: Record<string, unknown>;
  errorDetail?: unknown;
};

export type DashboardViewDraftDTO = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug?: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  compiledSql?: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  status?: DashboardViewStatus;
};

export type DashboardPreviewResponse = {
  sql: string;
  sourceTables: string[];
  dependencies: string[];
  durationMs: number;
  rowsCount: number;
  result: DashboardNormalizedResult;
  resultMeta: Record<string, unknown>;
  sqlHash: string;
};

export type ListDashboardPagesRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
};

export type ListDashboardPagesResponse = {
  pages: DashboardPageSummaryDTO[];
};

export type GetDashboardPageRequest = {
  pageId: RecordIdString;
};

export type GetDashboardPageResponse = {
  page: DashboardPageDTO;
  views: DashboardViewDTO[];
  caches: DashboardCacheDTO[];
};

export type CreateDashboardPageRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  description?: string;
};

export type CreateDashboardPageResponse = {
  page: DashboardPageDTO;
};

export type RenameDashboardPageRequest = {
  pageId: RecordIdString;
  title: string;
};

export type RenameDashboardPageResponse = {
  page: DashboardPageDTO;
};

export type SaveDashboardPageLayoutRequest = {
  pageId: RecordIdString;
  widgets: DashboardWidgetLayoutDTO[];
};

export type SaveDashboardPageLayoutResponse = {
  page: DashboardPageDTO;
};

export type ListDashboardViewsRequest = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
};

export type ListDashboardViewsResponse = {
  views: DashboardViewSummaryDTO[];
};

export type CreateDashboardViewRequest = {
  draft: DashboardViewDraftDTO;
};

export type CreateDashboardViewResponse = {
  view: DashboardViewDTO;
  cache?: DashboardCacheDTO;
};

export type UpdateDashboardViewRequest = {
  viewId: RecordIdString;
  draft: DashboardViewDraftDTO;
};

export type UpdateDashboardViewResponse = {
  view: DashboardViewDTO;
  cache?: DashboardCacheDTO;
};

export type PreviewDashboardViewRequest = {
  draft: DashboardViewDraftDTO;
};

export type PreviewDashboardViewResponse = DashboardPreviewResponse;

export type RefreshDashboardViewRequest = {
  viewId: RecordIdString;
};

export type RefreshDashboardViewResponse = {
  cache: DashboardCacheDTO;
};

export type RefreshDashboardPageRequest = {
  pageId: RecordIdString;
};

export type RefreshDashboardPageResponse = {
  caches: DashboardCacheDTO[];
};

// ─── RPC 契约 ─────────────────────────────────────────────────────────────────

export interface AppRPC extends ElectrobunRPCSchema {
  bun: {
    requests: {
      query: { params: RawQueryRequest; response: RawQueryResponse };
      getAuthState: { params: Record<string, never>; response: AuthState };
      logout: { params: Record<string, never>; response: void };
      getAppBootstrap: { params: Record<string, never>; response: Result<AppBootstrap> };
      listWorkbooks: { params: ListWorkbooksRequest; response: Result<ListWorkbooksResponse> };
      createBlankWorkbook: { params: CreateBlankWorkbookRequest; response: Result<CreateBlankWorkbookResponse> };
      listFolders: { params: ListFoldersRequest; response: Result<ListFoldersResponse> };
      createFolder: { params: CreateFolderRequest; response: Result<CreateFolderResponse> };
      moveFolder: { params: MoveFolderRequest; response: Result<MoveFolderResponse> };
      moveWorkbook: { params: MoveWorkbookRequest; response: Result<MoveWorkbookResponse> };
      listTemplates: { params: Record<string, never>; response: Result<ListTemplatesResponse> };
      createWorkbookFromTemplate: { params: CreateWorkbookFromTemplateRequest; response: Result<CreateWorkbookFromTemplateResponse> };
      getWorkbookData: { params: GetWorkbookDataRequest; response: Result<GetWorkbookDataResponse> };
      upsertRows: { params: UpsertRowsRequest; response: Result<UpsertRowsResponse> };
      deleteRows: { params: DeleteRowsRequest; response: Result<DeleteRowsResponse> };
      renameWorkbook: { params: RenameWorkbookRequest; response: Result<RenameWorkbookResponse> };
      updateSheetFields: { params: UpdateSheetFieldsRequest; response: Result<UpdateSheetFieldsResponse> };
      createSheet: { params: CreateSheetRequest; response: Result<CreateSheetResponse> };
      renameSheet: { params: RenameSheetRequest; response: Result<RenameSheetResponse> };
      resolveReferences: { params: ResolveReferencesRequest; response: Result<ResolveReferencesResponse> };
      listReferenceTargets: { params: Record<string, never>; response: Result<ListReferenceTargetsResponse> };
      searchReferenceCandidates: { params: SearchReferenceCandidatesRequest; response: Result<SearchReferenceCandidatesResponse> };
      listDashboardPages: { params: ListDashboardPagesRequest; response: Result<ListDashboardPagesResponse> };
      getDashboardPage: { params: GetDashboardPageRequest; response: Result<GetDashboardPageResponse> };
      createDashboardPage: { params: CreateDashboardPageRequest; response: Result<CreateDashboardPageResponse> };
      renameDashboardPage: { params: RenameDashboardPageRequest; response: Result<RenameDashboardPageResponse> };
      saveDashboardPageLayout: { params: SaveDashboardPageLayoutRequest; response: Result<SaveDashboardPageLayoutResponse> };
      listDashboardViews: { params: ListDashboardViewsRequest; response: Result<ListDashboardViewsResponse> };
      createDashboardView: { params: CreateDashboardViewRequest; response: Result<CreateDashboardViewResponse> };
      updateDashboardView: { params: UpdateDashboardViewRequest; response: Result<UpdateDashboardViewResponse> };
      previewDashboardView: { params: PreviewDashboardViewRequest; response: Result<PreviewDashboardViewResponse> };
      refreshDashboardView: { params: RefreshDashboardViewRequest; response: Result<RefreshDashboardViewResponse> };
      refreshDashboardPage: { params: RefreshDashboardPageRequest; response: Result<RefreshDashboardPageResponse> };
    };
    messages: {
      log: { msg: string };
      startLogin: Record<string, never>;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      pushRows: { rows: LegacyRowData[] };
      authStateChanged: { state: AuthState };
    };
  };
}
