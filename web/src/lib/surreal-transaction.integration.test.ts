import { afterEach, describe, expect, test } from "bun:test";
import { Surreal, Table } from "surrealdb";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

describe("SurrealDB 3.2.3 DDL + DML transaction contract", () => {
  localSurrealTest("字段 DDL、业务 INSERT 与元数据 UPDATE 一起提交或一起回滚", async () => {
    const db = new Surreal();
    opened.push(db);
    const suffix = Date.now().toString(36);
    const dataTable = `tx_data_${suffix}`;
    const metadataTable = `tx_meta_${suffix}`;
    await db.connect(process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc", {
      authentication: {
        username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
        password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
      },
      namespace: process.env.LOCAL_SURREAL_NS ?? "main",
      database: process.env.LOCAL_SURREAL_DB ?? "runtime_integration",
    });

    await db.query(`
      DEFINE TABLE ${dataTable} SCHEMAFULL;
      DEFINE TABLE ${metadataTable} SCHEMAFULL;
      DEFINE FIELD table_name ON ${metadataTable} TYPE string;
      CREATE ${metadataTable}:one SET table_name = '${dataTable}';
    `).collect();

    const committed = await db.beginTransaction();
    await committed.query(`DEFINE FIELD name ON ${dataTable} TYPE string`).collect();
    await committed.insert(new Table(dataTable), { name: "one" });
    await committed.update(`${metadataTable}:one`).merge({ table_name: `${dataTable}_committed` });
    await committed.commit();

    const committedRows = await db.query<[
      Array<{ name: string }>,
      Array<{ table_name: string }>,
    ]>(`SELECT * FROM ${dataTable}; SELECT * FROM ${metadataTable}:one;`).collect();
    expect(committedRows[0]).toHaveLength(1);
    expect(committedRows[1][0]?.table_name).toBe(`${dataTable}_committed`);

    const rolledBack = await db.beginTransaction();
    await rolledBack.query(`DEFINE FIELD amount ON ${dataTable} TYPE number`).collect();
    await expect(rolledBack.insert(new Table(dataTable), { name: "bad", amount: "wrong" })).rejects.toThrow();
    await rolledBack.cancel();

    const info = await db.query<[Array<{ fields: Record<string, string> }>]>(
      `RETURN (INFO FOR TABLE ${dataTable}).fields`,
    ).collect();
    expect(JSON.stringify(info)).not.toContain("amount");
  }, 10_000);
});
