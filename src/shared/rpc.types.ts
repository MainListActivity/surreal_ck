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
};

export type ListWorkbooksResponse = {
  workbooks: WorkbookSummaryDTO[];
};

export type CreateBlankWorkbookRequest = {
  workspaceId: RecordIdString;
  name: string;
};

export type CreateBlankWorkbookResponse = {
  workbook: WorkbookSummaryDTO;
};

// ─── RPC 契约 ─────────────────────────────────────────────────────────────────

export interface AppRPC extends ElectrobunRPCSchema {
  bun: {
    requests: {
      query: { params: RawQueryRequest; response: RawQueryResponse };
      getAuthState: { params: Record<string, never>; response: AuthState };
      logout: { params: Record<string, never>; response: void };
      getAppBootstrap: { params: Record<string, never>; response: Result<AppBootstrap> };
      // 占位：后续 Unit 3+ 实现业务逻辑
      listWorkbooks: { params: ListWorkbooksRequest; response: Result<ListWorkbooksResponse> };
      createBlankWorkbook: { params: CreateBlankWorkbookRequest; response: Result<CreateBlankWorkbookResponse> };
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
