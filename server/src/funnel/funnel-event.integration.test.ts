import { afterEach, describe, expect, test } from "bun:test";
import { jsonify, Surreal } from "surrealdb";

/**
 * 返工 B1：059 去掉 subject 与主体唯一索引后，重复触发仍不重复计数——
 * 幂等由触发点保证（CREATE 一次、带 $before 的边沿 UPDATE、first_success 全局查重）。
 * 用真实 059 迁移在本地公司 fork 实例上验证（与其他 .integration 测试同门控）。
 */

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

const SURREAL_URL = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_NS = process.env.LOCAL_SURREAL_NS ?? "main";
const AUTH = {
  username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
  password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
};

async function setup(): Promise<{ db: Surreal; database: string }> {
  const database = `funnel_ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const db = new Surreal();
  opened.push(db);
  await db.connect(SURREAL_URL, { authentication: AUTH });
  await db.query(
    `DEFINE NAMESPACE IF NOT EXISTS ${SURREAL_NS}; USE NS ${SURREAL_NS}; DEFINE DATABASE IF NOT EXISTS ${database};`,
  ).collect();
  await db.use({ namespace: SURREAL_NS, database });
  // 059 只依赖这些表的 CREATE/UPDATE 触发点；占位定义为 SCHEMALESS 即可。
  await db.query(`
    DEFINE TABLE user SCHEMALESS;
    DEFINE TABLE workbook SCHEMALESS;
    DEFINE TABLE import_batch SCHEMALESS;
    DEFINE TABLE import_batch_row SCHEMALESS;
    DEFINE TABLE chat_write_fence SCHEMALESS;
  `).collect();
  const sql = await Bun.file(new URL(
    "../../../shared/sql/workspace-template/059-funnel-event.surql",
    import.meta.url,
  )).text();
  await db.query(sql).collect();
  return { db, database };
}

async function rows(db: Surreal): Promise<Array<Record<string, unknown>>> {
  return jsonify((await db.query<[unknown[]]>("SELECT event, day, created_at FROM funnel_event;"))[0]) as Array<Record<string, unknown>>;
}

async function countOf(db: Surreal, event: string): Promise<number> {
  return (await rows(db)).filter((row) => row.event === event).length;
}

describe("059 funnel_event — 返工 B1 幂等（公司 fork 真机）", () => {
  localSurrealTest("重复触发不重复计数：CREATE 一次、边沿 UPDATE、first_success 全局唯一", async () => {
    const { db } = await setup();

    // first_login / template_created：CREATE 事件天然一次。
    await db.query(`CREATE user SET kind = "human", subject = "u1";`).collect();
    await db.query(`CREATE user SET kind = "virtual", subject = "e1";`).collect(); // 虚拟员工不计
    await db.query(`CREATE user SET kind = "human", subject = "u2";`).collect();
    await db.query(`CREATE workbook SET name = "a", template = workbook_template:bkc;`).collect();
    await db.query(`CREATE workbook SET name = "b";`).collect(); // 无模板不计
    expect(await countOf(db, "first_login")).toBe(2);
    expect(await countOf(db, "template_created")).toBe(1);

    // import_succeeded：边沿 UPDATE；同一状态重复 UPDATE 不再落行。
    await db.query(`
      CREATE import_batch SET status = "pending";
      CREATE import_batch_row SET batch = (SELECT VALUE id FROM import_batch LIMIT 1)[0], status = "success";
    `).collect();
    await db.query(`UPDATE import_batch SET status = "completed";`).collect();
    await db.query(`UPDATE import_batch SET status = "completed";`).collect();
    await db.query(`UPDATE import_batch SET note = "no-status-change";`).collect();
    expect(await countOf(db, "import_succeeded")).toBe(1);
    expect(await countOf(db, "first_success")).toBe(1);

    // 第二个批次：再次成功只加 import_succeeded，不再有 first_success。
    await db.query(`
      CREATE import_batch SET status = "pending";
      CREATE import_batch_row SET batch = (SELECT VALUE id FROM import_batch WHERE status = "pending" LIMIT 1)[0], status = "success";
    `).collect();
    await db.query(`UPDATE import_batch SET status = "partial_failure" WHERE status = "pending";`).collect();
    expect(await countOf(db, "import_succeeded")).toBe(2);
    expect(await countOf(db, "first_success")).toBe(1);

    // 无成功行的批次不计。
    await db.query(`
      CREATE import_batch SET status = "pending";
      CREATE import_batch_row SET batch = (SELECT VALUE id FROM import_batch WHERE status = "pending" LIMIT 1)[0], status = "failed";
    `).collect();
    await db.query(`UPDATE import_batch SET status = "completed" WHERE status = "pending";`).collect();
    expect(await countOf(db, "import_succeeded")).toBe(2);

    // ai_proposal_adopted：边沿 UPDATE；重复同样 UPDATE 不再落行。
    await db.query(`CREATE chat_write_fence SET status = "pending";`).collect();
    await db.query(`UPDATE chat_write_fence SET status = "consumed", consumed_by = "write-confirmed";`).collect();
    await db.query(`UPDATE chat_write_fence SET status = "consumed", consumed_by = "write-confirmed";`).collect();
    expect(await countOf(db, "ai_proposal_adopted")).toBe(1);

    // 行只含 event / day / created_at，无 subject。
    const all = await rows(db);
    expect(all.length).toBe(7);
    for (const row of all) {
      expect(Object.keys(row).sort()).toEqual(["created_at", "day", "event"]);
    }
  }, 30_000);

  localSurrealTest("059 可重复执行（IF NOT EXISTS + EVENT OVERWRITE）且不产生重复行", async () => {
    const { db } = await setup();
    await db.query(`CREATE user SET kind = "human", subject = "u1";`).collect();
    expect(await countOf(db, "first_login")).toBe(1);

    const sql = await Bun.file(new URL(
      "../../../shared/sql/workspace-template/059-funnel-event.surql",
      import.meta.url,
    )).text();
    await db.query(sql).collect();
    await db.query(`CREATE user SET kind = "human", subject = "u2";`).collect();
    expect(await countOf(db, "first_login")).toBe(2);
  }, 30_000);
});
