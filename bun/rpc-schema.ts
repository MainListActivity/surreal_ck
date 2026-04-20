import { type ElectrobunRPCSchema, type RPCSchema } from "electrobun/bun";

/**
 * Electrobun 全局 RPC Schema
 *
 * bun.requests:    webview → bun 的请求（有响应）
 * webview.messages: bun → webview 的推送消息（无需响应）
 */
export type AppRPCSchema = ElectrobunRPCSchema & {
  /** Bun 侧处理的请求 */
  bun: RPCSchema<{
    requests: {
      dbQuery: {
        params: { sql: string; vars?: Record<string, unknown> };
        response: unknown;
      };
      dbCreate: {
        params: { table: string; data: Record<string, unknown> };
        response: Record<string, unknown>;
      };
      dbMerge: {
        params: { recordId: string; data: Record<string, unknown> };
        response: Record<string, unknown>;
      };
      dbDelete: {
        params: { recordId: string };
        response: void;
      };
      dbUpsert: {
        params: { table: string; data: Record<string, unknown> };
        response: Record<string, unknown>;
      };
      getLocalUser: {
        params: Record<string, never>;
        response: { id: string; name: string };
      };
    };
    messages: Record<never, unknown>;
  }>;

  /** Webview 侧接收的推送消息 */
  webview: RPCSchema<{
    requests: Record<never, unknown>;
    messages: {
      onChangefeed: {
        table: string;
        action: "CREATE" | "UPDATE" | "DELETE";
        id: string;
        record: Record<string, unknown> | null;
      };
      onSyncStatus: {
        status: "idle" | "syncing" | "error";
        detail?: string;
      };
    };
  }>;
};
