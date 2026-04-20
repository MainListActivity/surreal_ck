/**
 * 数据库访问层（local-first IPC 版本）
 *
 * 原来直接调用 surrealdb SDK，现在改为通过 electrobun IPC 调用 Bun 主进程，
 * 主进程内部使用 @surrealdb/node（surrealkv 存储）执行实际操作。
 *
 * 这样 webview 代码永远不直接持有数据库连接，所有 DB 操作走 IPC。
 */
import { useSyncExternalStore } from "react";
import { ipc, onChangefeed, onSyncStatus } from "../../../views/main/ipc";

// ---- 连接状态模拟（IPC 不需要真正的连接管理，但保留 API 兼容性）----

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "auth-failed";

export interface ConnectionSnapshot {
  state: ConnectionState;
  detail?: string;
  updatedAt: number;
}

type Listener = (snapshot: ConnectionSnapshot) => void;

class ConnectionStateStore {
  #snapshot: ConnectionSnapshot = {
    state: "connected", // IPC 模式下默认视为已连接（主进程管理 DB）
    updatedAt: Date.now(),
  };

  #listeners = new Set<Listener>();

  getSnapshot(): ConnectionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  set(state: ConnectionState, detail?: string): void {
    this.#snapshot = { state, detail, updatedAt: Date.now() };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export const connectionState = new ConnectionStateStore();

// 订阅主进程同步状态通知，映射到连接状态
onSyncStatus(({ status, detail }) => {
  if (status === "syncing") connectionState.set("connecting", detail);
  else if (status === "error") connectionState.set("error", detail);
  else connectionState.set("connected");
});

export function useConnectionSnapshot(): ConnectionSnapshot {
  return useSyncExternalStore(
    (listener) => connectionState.subscribe(listener),
    () => connectionState.getSnapshot(),
    () => connectionState.getSnapshot(),
  );
}

// ---- 数据库操作 API（委托给 IPC）----

export async function dbQuery<T = unknown>(
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T> {
  return ipc.dbQuery<T>({ sql, vars });
}

export async function dbCreate(
  table: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return ipc.dbCreate({ table, data });
}

export async function dbMerge(
  recordId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return ipc.dbMerge({ recordId, data });
}

export async function dbDelete(recordId: string): Promise<void> {
  return ipc.dbDelete({ recordId });
}

export async function dbUpsert(
  table: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return ipc.dbUpsert({ table, data });
}

export async function getLocalUser(): Promise<{ id: string; name: string }> {
  return ipc.getLocalUser();
}

// 重新导出 CHANGEFEED 订阅，供 React hooks 使用
export { onChangefeed, onSyncStatus };
