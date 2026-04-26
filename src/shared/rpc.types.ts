import type { ElectrobunRPCSchema } from "electrobun/bun";

export type RowData = {
  id: string;
  name: string;
  value: string;
};

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

export type CurrentUserSummary = {
  id: string;
  subject: string;
  email?: string;
  name?: string;
  displayName?: string;
  avatar?: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
};

export type AppBootstrap =
  | { loggedIn: false; offlineMode?: boolean }
  | {
      loggedIn: true;
      offlineMode?: boolean;
      readOnly: boolean;
      user: CurrentUserSummary;
      defaultWorkspace: WorkspaceSummary;
    };

// ─── RPC 契约 ─────────────────────────────────────────────────────────────────

export interface AppRPC extends ElectrobunRPCSchema {
  bun: {
    requests: {
      query: { params: { sql: string }; response: unknown[] };
      getAuthState: { params: Record<string, never>; response: AuthState };
      logout: { params: Record<string, never>; response: void };
      getAppBootstrap: { params: Record<string, never>; response: Result<AppBootstrap> };
      // 占位：后续 Unit 3+ 实现业务逻辑
      listWorkbooks: { params: { workspaceId: string }; response: Result<unknown[]> };
      createBlankWorkbook: { params: { workspaceId: string; name: string }; response: Result<unknown> };
    };
    messages: {
      log: { msg: string };
      startLogin: Record<string, never>;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      pushRows: { rows: RowData[] };
      authStateChanged: { state: AuthState };
    };
  };
}
