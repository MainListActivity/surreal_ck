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
