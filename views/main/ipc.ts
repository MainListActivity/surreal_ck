/**
 * IPC 客户端：webview 端通过此模块与 Bun 主进程通信
 * 替代原来的 surrealdb SDK 直连
 *
 * 使用方式：
 *   import { ipc } from './ipc';
 *   const result = await ipc.dbQuery({ sql: 'SELECT * FROM workbook' });
 */
import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../../bun/rpc-schema";

type ChangefeedEvent = {
  table: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  id: string;
  record: Record<string, unknown> | null;
};

type SyncStatusEvent = {
  status: "idle" | "syncing" | "error";
  detail?: string;
};

type ChangefeedHandler = (event: ChangefeedEvent) => void;
type SyncStatusHandler = (event: SyncStatusEvent) => void;

// CHANGEFEED / 同步状态订阅注册表
const changefeedHandlers = new Set<ChangefeedHandler>();
const syncStatusHandlers = new Set<SyncStatusHandler>();

// 定义 webview 侧 RPC：处理来自 bun 的 messages
const rpc = Electroview.defineRPC<AppRPCSchema>({
  handlers: {
    messages: {
      onChangefeed(payload) {
        for (const handler of changefeedHandlers) {
          handler(payload);
        }
      },
      onSyncStatus(payload) {
        for (const handler of syncStatusHandlers) {
          handler(payload);
        }
      },
    },
  },
});

// 初始化 Electroview，绑定 rpc 并建立与 bun 的 WebSocket 连接
const view = new Electroview({ rpc });

// 便捷封装：将 requests 代理暴露为 async 方法
class IpcClient {
  async dbQuery<T = unknown>(params: {
    sql: string;
    vars?: Record<string, unknown>;
  }): Promise<T> {
    return view.rpc!.request.dbQuery(params) as Promise<T>;
  }

  async dbCreate(params: {
    table: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return view.rpc!.request.dbCreate(params);
  }

  async dbMerge(params: {
    recordId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return view.rpc!.request.dbMerge(params);
  }

  async dbDelete(params: { recordId: string }): Promise<void> {
    return view.rpc!.request.dbDelete(params);
  }

  async dbUpsert(params: {
    table: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return view.rpc!.request.dbUpsert(params);
  }

  async getLocalUser(): Promise<{ id: string; name: string }> {
    return view.rpc!.request.getLocalUser({});
  }
}

export const ipc = new IpcClient();

/**
 * 订阅 CHANGEFEED 变更（可按 table 过滤）
 * 返回取消订阅函数
 */
export function onChangefeed(
  handler: ChangefeedHandler,
  filter?: { table?: string },
): () => void {
  const wrapped: ChangefeedHandler = (event) => {
    if (filter?.table && event.table !== filter.table) return;
    handler(event);
  };
  changefeedHandlers.add(wrapped);
  return () => changefeedHandlers.delete(wrapped);
}

/**
 * 订阅同步状态通知
 * 返回取消订阅函数
 */
export function onSyncStatus(handler: SyncStatusHandler): () => void {
  syncStatusHandlers.add(handler);
  return () => syncStatusHandlers.delete(handler);
}
