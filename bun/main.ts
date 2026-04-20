import { BrowserWindow, BrowserView, defineElectrobunRPC } from "electrobun/bun";
import type { AppRPCSchema } from "./rpc-schema";
import {
  initLocalDb,
  dbQuery,
  dbCreate,
  dbMerge,
  dbDelete,
  dbUpsert,
  startChangefeedListener,
} from "./db";
import { initSchema } from "./schema";

// 需要监听 LIVE SELECT 的表（与 schema.ts 中开启了 CHANGEFEED 的表对应）
const WATCHED_TABLES = [
  "workspace",
  "workbook",
  "sheet",
  "mutation",
  "snapshot",
  "presence",
  "workbook_has_mutation",
  "folder",
  "doc",
  "form_definition",
  "edge_catalog",
  "workspace_member",
];

async function main() {
  // 1. 初始化本地 SurrealDB + Schema
  await initLocalDb();
  await initSchema();
  console.log("[Main] 本地数据库初始化完成");

  // 2. 定义 RPC（bun 侧处理 webview 的 requests，同时可向 webview 发送 messages）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestHandlers: any = {
    dbQuery: (params: { sql: string; vars?: Record<string, unknown> }) =>
      dbQuery(params.sql, params.vars),
    dbCreate: (params: { table: string; data: Record<string, unknown> }) =>
      dbCreate(params.table, params.data),
    dbMerge: (params: { recordId: string; data: Record<string, unknown> }) =>
      dbMerge(params.recordId, params.data),
    dbDelete: (params: { recordId: string }) => dbDelete(params.recordId),
    dbUpsert: (params: { table: string; data: Record<string, unknown> }) =>
      dbUpsert(params.table, params.data),
    getLocalUser: async () => {
      const deviceId = await getOrCreateDeviceId();
      return { id: deviceId, name: "本地用户" };
    },
  };

  const rpc = BrowserView.defineRPC<AppRPCSchema>({
    handlers: {
      requests: requestHandlers,
    },
  });

  // 3. 创建主窗口，将 rpc 实例绑定到 webview
  const mainWindow = new BrowserWindow<typeof rpc>({
    title: "SurrealCK",
    html: "views/main/index.html",
    frame: {
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    },
    rpc,
  });

  // 4. 启动 CHANGEFEED 监听，将变更推送到 webview
  const stopChangefeed = await startChangefeedListener(
    WATCHED_TABLES,
    (table, action, id, record) => {
      rpc.send.onChangefeed({
        table,
        action,
        id,
        record: record ?? null,
      });
    },
  );

  console.log("[Main] 应用启动完成");

  // 5. 窗口关闭时清理监听
  mainWindow.on("close", () => {
    stopChangefeed();
  });
}

/**
 * 获取或创建设备唯一标识（持久化到本地 DB）
 */
async function getOrCreateDeviceId(): Promise<string> {
  const rows = await dbQuery<Array<{ id: string; deviceId: string }>>(
    "SELECT id, deviceId FROM app_config WHERE id = app_config:device LIMIT 1",
  );

  if (Array.isArray(rows) && rows.length > 0 && rows[0].deviceId) {
    return rows[0].deviceId;
  }

  const deviceId = crypto.randomUUID();
  await dbUpsert("app_config", { id: "app_config:device", deviceId });
  return deviceId;
}

main().catch((err) => {
  console.error("[Main] 启动失败:", err);
  process.exit(1);
});
