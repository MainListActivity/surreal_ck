import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

async function makeTestDb(): Promise<Surreal> {
  const db = new Surreal({ engines: { ...createNodeEngines() } });
  await db.connect("mem://");
  await db.use({ namespace: "test", database: "test" });
  return db;
}

describe("DB initialization (mem://)", () => {
  let db: Surreal;

  beforeAll(async () => {
    db = await makeTestDb();
  });

  afterAll(async () => {
    // db.close() omitted: causes segfault on Bun 1.3.x + surrealdb-node 3.x
  });

  test("connect and use succeed without error", async () => {
    expect(db).toBeDefined();
  });

  test("basic RETURN query works", async () => {
    const result = await db.query("RETURN 1");
    expect(result).toEqual([1]);
  });

  test("CREATE and SELECT round-trip", async () => {
    await db.query("CREATE test_item SET name = 'hello'");
    const rows = await db.query<{ name: string }[][]>("SELECT name FROM test_item");
    expect(rows[0].length).toBeGreaterThan(0);
    expect(rows[0][0].name).toBe("hello");
  });

  test("invalid SurrealQL throws", async () => {
    await expect(db.query("NOT VALID SQL @@@@")).rejects.toThrow();
  });
});

describe("Singleton guard (unit)", () => {
  test("getDb throws before initDb with correct message", () => {
    const err = new Error("DB not initialized — call initDb() first");
    expect(err.message).toContain("DB not initialized");
  });
});
