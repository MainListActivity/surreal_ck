import type { BoundQuery } from "surrealdb";

export type SyncQuery = string | BoundQuery;

export type SyncDb = {
  query<T = unknown>(sql: SyncQuery, bindings?: Record<string, unknown>): Promise<T>;
};

export type LiveAction = "CREATE" | "UPDATE" | "DELETE" | "KILLED";

export type LiveMessage = {
  action: LiveAction;
  recordId: string;
  value: Record<string, unknown>;
};

export type LiveHandler = (message: LiveMessage) => void | Promise<void>;

export type LiveSource = {
  subscribe(table: string, handler: LiveHandler): Promise<() => void>;
};

export type SyncDirection = "local_to_remote" | "remote_to_local";

export type SyncOperation = "create" | "update" | "delete";

export type SyncChange = {
  table: string;
  versionstamp: string;
  op: SyncOperation;
  recordId: string;
  content: Record<string, unknown>;
  dirtyFields?: string[];
};

export type SyncRunResult = {
  pulled: number;
  pushed: number;
  skipped: number;
  failed: number;
};

export type SyncWorkerOptions = {
  localDb: SyncDb;
  remoteDb: SyncDb;
  tables: string[];
  isOnline: () => boolean;
};
