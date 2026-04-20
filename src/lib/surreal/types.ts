/**
 * 应用领域类型定义（local-first 版本）
 *
 * 在 local-first 架构下，SurrealDB 类型（RecordId, DateTime）
 * 从 @surrealdb/node 导入，仅用于主进程（Bun 端）代码。
 * webview 端使用字符串 ID（"table:id" 格式），从 IPC 响应中获取。
 */

// webview 端的 ID 类型：纯字符串
export type RecordIdString = string; // 格式: "table:id"

export type WorkspaceRole = "admin" | "editor" | "viewer";

export interface AppUser {
  id: RecordIdString;
  subject: string;
  email: string;
  display_name?: string;
  created_at: string; // ISO 8601
  updated_at: string;
}

export interface Workspace {
  id: RecordIdString;
  name: string;
  slug: string;
  owner?: RecordIdString;
  created_at: string;
}

export interface Workbook {
  id: RecordIdString;
  workspace?: RecordIdString;
  name: string;
  template_key?: string;
  last_viewed_sheet?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: RecordIdString;
  workspace: RecordIdString;
  email: string;
  role: WorkspaceRole;
  invited_at: string;
}

export interface MutationRecord {
  id: RecordIdString;
  workbook?: RecordIdString;
  workspace?: RecordIdString;
  command_id: string;
  params: Record<string, unknown>;
  client_id: string;
  actor?: string;
  created_at: string;
}

export interface SnapshotRecord {
  id: RecordIdString;
  workbook?: RecordIdString;
  layout: Record<string, unknown>;
  coordinator_client_id: string;
  mutation_watermark?: string;
  created_at: string;
}

export interface FormDefinition {
  id: RecordIdString;
  workspace?: RecordIdString;
  title: string;
  slug: string;
  target_sheet: RecordIdString;
  fields: Array<Record<string, unknown>>;
  conditional_rules: Array<Record<string, unknown>>;
  auto_edges: Array<Record<string, unknown>>;
  created_at: string;
}

export interface Sheet {
  id: RecordIdString;
  workbook: RecordIdString;
  univer_id: string;
  table_name: string;
  label: string;
  position: number;
  column_defs: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

export interface EdgeCatalogEntry {
  id: RecordIdString;
  workspace: RecordIdString;
  key: string;
  label: string;
  rel_table: string;
  from_table: string | null;
  to_table: string | null;
  edge_props: Array<Record<string, unknown>>;
  created_at: string;
}

export interface ClientErrorRecord {
  id: RecordIdString;
  workspace?: RecordIdString;
  workbook?: RecordIdString;
  client_id?: string;
  error_code: string;
  message: string;
  meta?: Record<string, unknown>;
  created_at: string;
}

// ---- 本地用户（取代 OIDC UserProfile）----

export interface LocalUser {
  /** 设备唯一 ID */
  id: string;
  name: string;
}

// ---- 兼容旧代码的别名（部分 router 代码仍在使用）----
export type UserProfile = LocalUser & {
  sub: string;
  email?: string;
  recordId: string;
};

// ---- 连接状态（IPC 版本）----

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "auth-failed"
  | "error";

export interface ConnectionSnapshot {
  state: ConnectionState;
  detail?: string;
  updatedAt: number;
}
