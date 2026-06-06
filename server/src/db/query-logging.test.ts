import { describe, expect, test } from "bun:test";
import { instrumentSurrealQuery } from "./query-logging";

class FakeSurreal {
  scope?: { namespace?: string; database?: string };
  queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];

  async use(scope: { namespace?: string; database?: string }): Promise<void> {
    this.scope = scope;
  }

  async query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T> {
    this.queries.push({ sql, params });
    if (sql.includes("THROW")) throw new Error("query failed");
    return [{ ok: true }] as T;
  }
}

describe("instrumentSurrealQuery", () => {
  test("only warns once for enabled server query logging failures", async () => {
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const infos: unknown[] = [];
    const warns: unknown[] = [];
    console.info = (...args: unknown[]) => {
      infos.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };

    try {
      const db = instrumentSurrealQuery(new FakeSurreal(), {
        source: "test-server",
        enabled: true,
        initialScope: { namespace: "main", database: "_system" },
      });

      await db.use({ namespace: "main", database: "ws_demo" });
      await db.query("SELECT * FROM user WHERE id = $id", { id: "user:1" });
      await expect(db.query("THROW 'nope';", { reason: "nope" })).rejects.toThrow("query failed");
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
    }

    expect(infos).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toEqual([
      "[surrealdb:query:error]",
      expect.objectContaining({
        source: "test-server",
        scope: { namespace: "main", database: "ws_demo" },
        sql: "THROW 'nope';",
        params: { reason: "nope" },
        response: { status: "THROWN" },
        error: "query failed",
      }),
    ]);
  });
});
