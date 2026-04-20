/**
 * 本地 SurrealDB Schema 初始化
 *
 * 在 Bun 主进程以 root 权限执行，建立本地数据库的 schema。
 * local-first 架构下不需要 PERMISSIONS（本地单用户访问）。
 * 同时为 LIVE SELECT（CHANGEFEED）需要的表开启变更订阅。
 */
import { getDb } from "./db";

const SCHEMA_SQL = `
-- 应用配置（设备 ID 等）
DEFINE TABLE IF NOT EXISTS app_config SCHEMALESS;

-- 工作空间
DEFINE TABLE IF NOT EXISTS workspace SCHEMALESS
  CHANGEFEED 1d;
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;

-- 工作簿
DEFINE TABLE IF NOT EXISTS workbook SCHEMALESS
  CHANGEFEED 1d;

-- Sheet（电子表格页签）
DEFINE TABLE IF NOT EXISTS sheet SCHEMALESS
  CHANGEFEED 1d;
DEFINE INDEX IF NOT EXISTS sheet_univer_id_unique ON TABLE sheet COLUMNS univer_id UNIQUE;

-- 协作变更日志
DEFINE TABLE IF NOT EXISTS mutation SCHEMALESS
  CHANGEFEED 1d;

-- 快照
DEFINE TABLE IF NOT EXISTS snapshot SCHEMALESS
  CHANGEFEED 1d;

-- 在线状态
DEFINE TABLE IF NOT EXISTS presence SCHEMALESS
  CHANGEFEED 10m;

-- 工作簿变更边
DEFINE TABLE IF NOT EXISTS workbook_has_mutation SCHEMALESS
  CHANGEFEED 1d;

-- 文件夹
DEFINE TABLE IF NOT EXISTS folder SCHEMALESS
  CHANGEFEED 1d;

-- 文档节点
DEFINE TABLE IF NOT EXISTS doc SCHEMALESS
  CHANGEFEED 1d;

-- 表单定义
DEFINE TABLE IF NOT EXISTS form_definition SCHEMALESS
  CHANGEFEED 1d;

-- 关系类型目录
DEFINE TABLE IF NOT EXISTS edge_catalog SCHEMALESS
  CHANGEFEED 1d;

-- 错误日志
DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS;

-- Workspace 成员
DEFINE TABLE IF NOT EXISTS workspace_member SCHEMALESS
  CHANGEFEED 1d;
`;

export async function initSchema(): Promise<void> {
  const db = getDb();
  await db.query(SCHEMA_SQL);
  console.log("[Schema] 本地数据库 schema 初始化完成");
}
