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
