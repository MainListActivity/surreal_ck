/**
 * 验证脚本：
 * 1. newSession() 在 embedded engine 下是否与主连接共享同一 KV 文件
 * 2. OPTION IMPORT 模式下 USE NS main DB docs 是否被忽略
 */
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

const DB_PATH = "surrealkv://./data/verify-test.db";

async function main() {
  const db = new Surreal({ engines: { ...createNodeEngines() } });
  await db.connect(DB_PATH);
  console.log("[1] connected to embedded engine");

  // --- 验证 1：newSession() 共享同一 KV ---
  const metaSession = await db.newSession();
  await metaSession.use({ namespace: "main", database: "_meta" });
  console.log("[2] metaSession.use(_meta) ok");

  // 通过 metaSession 写入
  await metaSession.query(`
    DEFINE TABLE IF NOT EXISTS app_meta SCHEMAFULL PERMISSIONS FULL;
    DEFINE FIELD IF NOT EXISTS last_user_db ON TABLE app_meta TYPE option<string>;
  `);
  await metaSession.query(`UPSERT app_meta:local SET last_user_db = 'u_testuser123'`);
  console.log("[3] wrote to _meta via metaSession");

  // 通过主实例切换到 _meta 后读取，验证数据共享
  await db.use({ namespace: "main", database: "_meta" });
  const fromMain = await db.query<[{ last_user_db: string }[]]>(
    `SELECT last_user_db FROM app_meta:local`
  );
  const val = fromMain[0]?.[0]?.last_user_db;
  if (val === "u_testuser123") {
    console.log("[✓] newSession() SHARES the same KV file — data visible from main instance");
  } else {
    console.log("[✗] newSession() does NOT share KV — data NOT visible from main instance, got:", val);
  }

  // --- 验证 2：OPTION IMPORT 下 USE 语句是否被忽略 ---
  // 先切换主实例到用户专属 DB
  await db.use({ namespace: "main", database: "u_testuser123" });
  console.log("[4] main db switched to u_testuser123");

  // 执行含 USE NS main DB docs 的 schema 片段
  const schemaWithUse = `
OPTION IMPORT;
USE NS main DB docs;
DEFINE TABLE IF NOT EXISTS _verify_target SCHEMALESS PERMISSIONS NONE;
`;
  await db.query(schemaWithUse);
  console.log("[5] executed schema with USE NS main DB docs while connected to u_testuser123");

  // 检查表在哪个 DB 里
  await db.use({ namespace: "main", database: "u_testuser123" });
  const inUserDb = await db.query<[{ name: string }[]]>(
    `INFO FOR DB`
  );
  const inUserDbTables = JSON.stringify(inUserDb[0]);

  await db.use({ namespace: "main", database: "docs" });
  const inDocsDb = await db.query<[{ name: string }[]]>(
    `INFO FOR DB`
  );
  const inDocsDbTables = JSON.stringify(inDocsDb[0]);

  if (inUserDbTables.includes("_verify_target")) {
    console.log("[✓] OPTION IMPORT ignores USE statement — table created in u_testuser123 (current session DB)");
  } else if (inDocsDbTables.includes("_verify_target")) {
    console.log("[✗] OPTION IMPORT does NOT ignore USE statement — table created in docs DB (USE took effect)");
    console.log("    → Need to strip USE line from schema before executing in user DB");
  } else {
    console.log("[?] _verify_target not found in either DB. inUserDb:", inUserDbTables.slice(0, 200));
    console.log("    inDocsDb:", inDocsDbTables.slice(0, 200));
  }

  // 清理
  await db.use({ namespace: "main", database: "u_testuser123" });
  await db.query(`REMOVE TABLE IF EXISTS _verify_target`);
  await db.use({ namespace: "main", database: "docs" });
  await db.query(`REMOVE TABLE IF EXISTS _verify_target`);
  await db.use({ namespace: "main", database: "_meta" });
  await db.query(`DELETE app_meta:local`);

  console.log("[done] cleanup complete");
  process.exit(0);
}

main().catch((e) => {
  console.error("[error]", e);
  process.exit(1);
});
