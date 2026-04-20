/**
 * DbAdapter：webview 端的数据库访问接口
 *
 * 替代原来直接传递 `Surreal` 实例的模式。
 * 所有业务组件和 hooks 应依赖此接口，而非具体的 SDK 实现。
 * 实际实现委托给 IPC 客户端（views/main/ipc.ts）。
 *
 * Live Query（原 db.live()）替换为 subscribe()，通过
 * Bun 主进程的 CHANGEFEED + IPC 推送实现实时更新。
 */
import { dbQuery, dbCreate, dbMerge, dbDelete, dbUpsert, onChangefeed } from "./client";

export type ChangefeedAction = "CREATE" | "UPDATE" | "DELETE";

export interface LiveMessage<T = Record<string, unknown>> {
  action: ChangefeedAction;
  id: string;
  record: T | null;
}

export interface DbAdapter {
  query<T = unknown>(
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<T>;

  create(
    table: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  merge(
    recordId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  delete(recordId: string): Promise<void>;

  upsert(
    table: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * 订阅指定表的实时变更（替代原 db.live()）
   * 通过 Bun 主进程的 CHANGEFEED + IPC 推送实现
   * @returns 取消订阅的函数
   */
  subscribe<T = Record<string, unknown>>(
    table: string,
    callback: (message: LiveMessage<T>) => void,
  ): () => void;
}

/**
 * 全局单例适配器——委托给 IPC 客户端
 */
export const db: DbAdapter = {
  query: dbQuery,
  create: dbCreate,
  merge: dbMerge,
  delete: dbDelete,
  upsert: dbUpsert,
  subscribe<T = Record<string, unknown>>(
    table: string,
    callback: (message: LiveMessage<T>) => void,
  ): () => void {
    return onChangefeed(
      ({ action, id, record }) => {
        callback({
          action,
          id,
          record: record as T | null,
        });
      },
      { table },
    );
  },
};

export default db;
