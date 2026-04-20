import { Surreal, RecordId, Table } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import * as path from "path";
import * as os from "os";

// SurrealKV 存储路径：~/Library/Application Support/SurrealCK/data（macOS）
// 或 ~/.local/share/SurrealCK/data（Linux）
// 或 %APPDATA%\SurrealCK\data（Windows）
function getDataDir(): string {
  const platform = process.platform;
  const appName = "SurrealCK";

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName, "data");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), appName, "data");
  } else {
    return path.join(os.homedir(), ".local", "share", appName, "data");
  }
}

const NS = "main";
const DB = "docs";

let db: Surreal | null = null;

export type ChangefeedHandler = (
  table: string,
  action: "CREATE" | "UPDATE" | "DELETE",
  id: string,
  record: Record<string, unknown> | null,
) => void;

/**
 * 初始化本地 SurrealDB（surrealkv 存储，通过 @surrealdb/node 嵌入引擎）
 */
export async function initLocalDb(): Promise<Surreal> {
  if (db) return db;

  const dataDir = getDataDir();

  db = new Surreal({
    engines: createNodeEngines(),
  });

  await db.connect(`surrealkv://${dataDir}`);
  await db.use({ namespace: NS, database: DB });

  console.log(`[DB] 本地数据库已连接: surrealkv://${dataDir}`);

  return db;
}

/**
 * 获取本地 DB 实例（必须先调用 initLocalDb）
 */
export function getDb(): Surreal {
  if (!db) throw new Error("本地数据库未初始化，请先调用 initLocalDb()");
  return db;
}

/**
 * 执行原始 SurrealQL 查询
 * 返回第一个语句的结果
 */
export async function dbQuery<T = unknown>(
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T> {
  const results = await getDb().query<[T]>(sql, vars);
  return results[0];
}

/**
 * 创建记录
 */
export async function dbCreate(
  table: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // create(Table) 返回数组
  const result = await getDb().create(new Table(table)).content(data);
  const row = Array.isArray(result) ? result[0] : result;
  return row as Record<string, unknown>;
}

/**
 * Merge（部分更新）—— 使用 update(recordId).merge(data)
 */
export async function dbMerge(
  recordId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const colonIdx = recordId.indexOf(":");
  if (colonIdx === -1) throw new Error(`无效的 recordId: ${recordId}`);
  const table = recordId.slice(0, colonIdx);
  const id = recordId.slice(colonIdx + 1);
  const result = await db!.update(new RecordId(table, id)).merge(data);
  return result as Record<string, unknown>;
}

/**
 * 删除记录
 */
export async function dbDelete(recordId: string): Promise<void> {
  const colonIdx = recordId.indexOf(":");
  if (colonIdx === -1) throw new Error(`无效的 recordId: ${recordId}`);
  const table = recordId.slice(0, colonIdx);
  const id = recordId.slice(colonIdx + 1);
  await db!.delete(new RecordId(table, id));
}

/**
 * 插入或更新（upsert）
 */
export async function dbUpsert(
  table: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await getDb().upsert(new Table(table)).content(data);
  const row = Array.isArray(result) ? result[0] : result;
  return row as Record<string, unknown>;
}

/**
 * 启动 CHANGEFEED 监听，将变更事件通知给 handler
 * 需要在 schema 中对目标表开启 CHANGEFEED
 */
export async function startChangefeedListener(
  tables: string[],
  handler: ChangefeedHandler,
): Promise<() => void> {
  const localDb = getDb();
  const killFns: Array<() => Promise<void>> = [];

  for (const table of tables) {
    const subscription = await localDb.live(new Table(table));

    const unsub = subscription.subscribe((msg) => {
      const action = msg.action as string;
      if (action === "KILLED") return;

      const id = msg.recordId.toString();
      const record = msg.value as Record<string, unknown>;
      const actionStr = action.toUpperCase() as "CREATE" | "UPDATE" | "DELETE";
      handler(table, actionStr, id, actionStr === "DELETE" ? null : record);
    });

    killFns.push(async () => {
      unsub();
      await subscription.kill();
    });
  }

  console.log(`[DB] CHANGEFEED 监听已启动: ${tables.join(", ")}`);

  return async () => {
    await Promise.all(killFns.map((fn) => fn()));
  };
}

export { RecordId };
