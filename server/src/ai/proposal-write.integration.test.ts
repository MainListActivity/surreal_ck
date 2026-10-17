/**
 * proposal-write 真实 fork SDK 回路：验证 SELECT ... FROM ONLY 裸对象形状
 * 经 firstRows 解出后，确认写不再误报 chat-write-target-unavailable 403。
 *
 * 默认跳过。本机跑：
 *   SURREAL_BINARY=$HOME/.surrealdb/surreal \
 *   RUN_LOCAL_SURREALDB_PROPOSAL_WRITE_TESTS=1 \
 *   bun test ./src/ai/proposal-write.integration.test.ts --preload ./test/setup-env.ts
 *
 * 先例：secret-store.integration.test.ts（182f0e8e）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Surreal, StringRecordId } from "surrealdb";
import { writeProposalValues } from "./proposal-write";

const enabled = process.env.RUN_LOCAL_SURREALDB_PROPOSAL_WRITE_TESTS === "1";
const localTest = test.skipIf(!enabled);
const surrealBinary = process.env.SURREAL_BINARY ?? `${process.env.HOME}/.surrealdb/surreal`;

let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function session(database: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "main", database });
  sessions.push(db);
  return db;
}

beforeAll(async () => {
  if (!enabled) return;
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn(
    [surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`, "--user", "root", "--pass", "root", "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint], { stdout: "ignore", stderr: "ignore" });
    if ((await ready.exited) === 0) break;
    await Bun.sleep(100);
  }
  const db = await session("proposal_write_it");
  // 最小 sheet + 业务表：只覆盖 firstRows / loadSheet / patch 路径，不拉全量 workspace 模板。
  await db.query(`
    DEFINE TABLE sheet SCHEMALESS;
    DEFINE TABLE p1 SCHEMALESS;
    CREATE sheet:s1 SET table_name = "p1", column_defs = [
      { key: "field_1", label: "field 1", field_type: "checkbox" },
      { key: "field_2", label: "field 2", field_type: "text" }
    ];
    CREATE p1:v1 SET field_1 = true, field_2 = "原值";
  `);
});

afterAll(async () => {
  await Promise.all(sessions.map(async (db) => { await db.close(); }));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("proposal-write 真实 fork SDK FROM ONLY 裸对象形状", () => {
  localTest("loadSheet / patch 经真实 ONLY 回读成功，不再 403", async () => {
    const db = sessions[0]!;
    // 直接断言 SDK 形状：FROM ONLY 的第一语句结果是裸对象，不是 [[row]]。
    const onlyShape = await db.query(
      "SELECT table_name, column_defs FROM ONLY $sheet;",
      { sheet: new StringRecordId("sheet:s1") },
    );
    expect(Array.isArray(onlyShape)).toBe(true);
    expect(Array.isArray(onlyShape[0])).toBe(false);
    expect(onlyShape[0]).toMatchObject({ table_name: "p1" });

    const tx = await db.beginTransaction();
    try {
      const outcome = await writeProposalValues(tx, {
        target: { sheetId: "sheet:s1", recordId: "p1:v1", operation: "patch" },
        values: { field_1: false },
      });
      expect(outcome.created).toBe(false);
      expect(Object.keys(outcome.written)).toEqual(["field_1"]);
      await tx.commit();
    } catch (error) {
      await tx.cancel().catch(() => undefined);
      throw error;
    }

    const after = await db.query("SELECT field_1, field_2 FROM ONLY $record;", {
      record: new StringRecordId("p1:v1"),
    });
    expect(after[0]).toMatchObject({ field_1: false, field_2: "原值" });
  }, 60_000);

  localTest("缺失 sheet 的 ONLY 无行 → 具名 403", async () => {
    const db = sessions[0]!;
    // fork SDK 对不存在的 ONLY 可能回 null 或 undefined；两者经 firstRows 都解成 []。
    const missing = await db.query(
      "SELECT table_name FROM ONLY $sheet;",
      { sheet: new StringRecordId("sheet:missing") },
    );
    expect(missing[0] == null).toBe(true);

    const tx = await db.beginTransaction();
    try {
      const error = await writeProposalValues(tx, {
        target: { sheetId: "sheet:missing", recordId: "p1:v1", operation: "patch" },
        values: { field_1: true },
      }).catch((e) => e);
      expect((error as { status: number }).status).toBe(403);
      expect((error as { code: string }).code).toBe("chat-write-target-unavailable");
      await tx.cancel();
    } catch (error) {
      await tx.cancel().catch(() => undefined);
      throw error;
    }
  }, 60_000);
});
