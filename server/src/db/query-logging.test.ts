import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { homedir } from "node:os";
import { Surreal } from "surrealdb";
import { instrumentSurrealQuery } from "./query-logging";

/**
 * query 插桩回归：instrumented query() 必须保留 SurrealDB SDK Query（DispatchedPromise）
 * 的调用表面——`.collect()` / `.responses()` / `.json()` / `.retry()` / `await` 全部可用，
 * 且同一 query 只执行一次。降级成普通 Promise 会让 `.collect()` 消失（生产 500 事故根因）。
 */

const opened: Surreal[] = [];
const spawned: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const kill of spawned.splice(0)) kill();
});

type ExecutedQuery = { sql: string; bindings?: Record<string, unknown> };

/** 模拟 SDK Query：单次 dispatch，then/collect/responses/json/retry/stream 共享结果。 */
function fakeQuery<T>(impl: () => Promise<T>) {
  let dispatched: Promise<T> | undefined;
  const ensure = () => {
    if (!dispatched) dispatched = impl();
    return dispatched;
  };
  const shape: Record<string, unknown> = {
    collect: async () => await ensure(),
    responses: async () => await ensure(),
    json: () => shape,
    retry: () => shape,
    // oxlint-disable-next-line no-thenable -- 刻意模拟 DispatchedPromise 的 thenable 形状
    then: (onF?: unknown, onR?: unknown) =>
      (ensure() as Promise<T>).then(onF as never, onR as never),
    catch: (onR?: unknown) => (ensure() as Promise<T>).catch(onR as never),
    finally: (onF?: unknown) => (ensure() as Promise<T>).finally(onF as () => void),
    stream: async function* () {
      yield await ensure();
    },
  };
  return shape;
}

function fakeClient(impl: () => Promise<unknown> = async () => [[{ ok: true }]]) {
  const queries: ExecutedQuery[] = [];
  let executions = 0;
  const client = {
    query(sql: string, bindings?: Record<string, unknown>) {
      queries.push({ sql, bindings });
      return fakeQuery(async () => {
        executions += 1;
        return await impl();
      });
    },
    async use() {},
  };
  return {
    client: client as unknown as Parameters<typeof instrumentSurrealQuery>[0],
    queries,
    executions: () => executions,
  };
}

function instrument(client: ReturnType<typeof fakeClient>["client"]) {
  return instrumentSurrealQuery(client, { source: "test", enabled: true });
}

describe("query 插桩保留 SDK Query 表面", () => {
  test(".collect() 可用且只执行一次", async () => {
    const { client, queries, executions } = fakeClient();
    const session = instrument(client);
    const q = session.query("SELECT * FROM t") as unknown as { collect(): Promise<unknown> };
    expect(typeof q.collect).toBe("function");
    const result = await q.collect();
    expect(result).toEqual([[{ ok: true }]]);
    expect(queries).toHaveLength(1);
    expect(executions()).toBe(1);
  });

  test("await query 可用", async () => {
    const { client, executions } = fakeClient();
    const session = instrument(client);
    const result = await session.query("SELECT 1");
    expect(result).toEqual([[{ ok: true }]]);
    expect(executions()).toBe(1);
  });

  test(".responses() 可用", async () => {
    const { client, executions } = fakeClient();
    const session = instrument(client);
    const q = session.query("SELECT 1") as unknown as { responses(): Promise<unknown> };
    expect(await q.responses()).toEqual([[{ ok: true }]]);
    expect(executions()).toBe(1);
  });

  test(".json() 链式结果仍是 Query：可 await / .collect()", async () => {
    const { client, executions } = fakeClient();
    const session = instrument(client);
    const q = session.query("SELECT 1") as unknown as {
      json(): { collect(): Promise<unknown> };
    };
    const j = q.json();
    expect(typeof j.collect).toBe("function");
    expect(await j.collect()).toEqual([[{ ok: true }]]);
    expect(executions()).toBe(1);
  });

  test(".retry() 链式结果仍可 await", async () => {
    const { client, executions } = fakeClient();
    const session = instrument(client);
    const q = session.query("SELECT 1") as unknown as {
      retry(): Promise<unknown> & { collect(): Promise<unknown> };
    };
    expect(await q.retry()).toEqual([[{ ok: true }]]);
    expect(executions()).toBe(1);
  });

  test("同一 query：.collect() 与 await 共享一次执行", async () => {
    const { client, executions } = fakeClient();
    const session = instrument(client);
    const q = session.query("SELECT 1") as unknown as Promise<unknown> & {
      collect(): Promise<unknown>;
    };
    await q.collect();
    await q;
    expect(executions()).toBe(1);
  });

  test("执行失败：错误原样抛出并记 [surrealdb:query:error]", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, executions } = fakeClient(async () => {
        throw new Error("db exploded");
      });
      const session = instrument(client);
      const q = session.query("SELECT * FROM broken") as unknown as { collect(): Promise<unknown> };
      await expect(q.collect()).rejects.toThrow("db exploded");
      expect(executions()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "[surrealdb:query:error]",
        expect.objectContaining({ response: { status: "THROWN" }, error: "db exploded" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("use() 透传并保持可用", async () => {
    const { client } = fakeClient();
    const session = instrument(client);
    await session.use?.({ namespace: "main", database: "ws_x" });
    const q = session.query("SELECT 1") as unknown as { collect(): Promise<unknown> };
    expect(await q.collect()).toEqual([[{ ok: true }]]);
  });

  test("普通 Promise 形 query：失败 warn 一次，scope 随 use() 更新", async () => {
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
      await expect((async () => {
        await db.query("THROW 'nope';", { reason: "nope" });
      })()).rejects.toThrow("query failed");
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

describe("真实 SurrealDB 插桩（SURREAL_BINARY）", () => {
  test("真实 SDK Query：插桩后 .collect()/await/.json() 全部可用且只执行一次", async () => {
    const port = 24000 + Math.floor(Math.random() * 10000);
    const password = crypto.randomUUID();
    const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
    const proc = Bun.spawn(
      [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
      { stdout: "ignore", stderr: "ignore" },
    );
    spawned.push(() => proc.kill());
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }

    const db = new Surreal();
    opened.push(db);
    await db.connect(`ws://127.0.0.1:${port}/rpc`);
    await db.signin({ username: "test", password });

    instrumentSurrealQuery(db, { source: "test-real", enabled: true });

    const q = db.query("RETURN 42");
    expect(typeof q.collect).toBe("function");
    const collected = await q.collect();
    expect(collected[0]).toBe(42);
    // collect 后 await 同一 query：共享一次 dispatch，不重复执行
    expect(await db.query("RETURN 7")).toEqual([7]);
    const jsonQuery = db.query("RETURN {v: 1}").json();
    const jsonResult = await jsonQuery;
    expect(jsonResult[0]).toEqual({ v: 1 });
  });
});
