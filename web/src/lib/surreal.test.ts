import { describe, expect, test } from "bun:test";
import { Table } from "surrealdb";
import { createBrowserConn, createSurrealClient, type SurrealConn, type SurrealConnectInput } from "./surreal";

type ConnectCall = { url: string; opts: unknown };

function fakeSurreal(overrides: Partial<SurrealConn> = {}) {
  const connectCalls: ConnectCall[] = [];
  const useCalls: unknown[] = [];
  let closed = false;
  let status: SurrealConn["status"] = "disconnected";

  let conn: SurrealConn;
  conn = {
    get status() {
      return status;
    },
    async connect(url, opts) {
      connectCalls.push({ url: String(url), opts });
      status = "connected";
      return true;
    },
    async use(what) {
      useCalls.push(what);
      return what ?? { namespace: null, database: null };
    },
    async close() {
      closed = true;
      status = "disconnected";
      return true;
    },
    subscribe() {
      return () => {};
    },
    query() {
      return Promise.resolve([]);
    },
    liveTable() {
      return Promise.resolve(() => {});
    },
    updateRecord(_id, patch) {
      return Promise.resolve(patch);
    },
    createRecord(_table, data) {
      return Promise.resolve(data);
    },
    transaction(run) {
      return run(conn);
    },
    ...overrides,
  };

  return {
    conn,
    connectCalls,
    useCalls,
    get closed() {
      return closed;
    },
    setStatus(next: SurrealConn["status"]) {
      status = next;
    },
  };
}

const input: SurrealConnectInput = {
  url: "ws://localhost:8000/rpc",
  rawToken: "raw.jwt.token",
  namespace: "main",
  dbName: "ws_a1b2c3d4e5f6",
};

describe("SurrealDB 浏览器直连客户端", () => {
  test("connectSurreal 用 raw token 连接到正确的 ns/db 并被 getSurreal 返回", async () => {
    const fake = fakeSurreal();
    const client = createSurrealClient({ factory: () => fake.conn });

    const connected = await client.connectSurreal(input);

    expect(fake.connectCalls).toHaveLength(1);
    expect(fake.connectCalls[0].url).toBe("ws://localhost:8000/rpc");
    expect(fake.connectCalls[0].opts).toMatchObject({
      namespace: "main",
      database: "ws_a1b2c3d4e5f6",
      authentication: "raw.jwt.token",
    });
    expect(connected).toBe(fake.conn);
    expect(client.getSurreal()).toBe(fake.conn);
  });

  test("切换 workspace 时先 close 旧连接再连新连接，getSurreal 指向最新", async () => {
    const first = fakeSurreal();
    const second = fakeSurreal();
    const conns = [first.conn, second.conn];
    const client = createSurrealClient({ factory: () => conns.shift()! });

    await client.connectSurreal(input);
    const order: string[] = [];
    first.conn.close = async () => {
      order.push("close-old");
      return true;
    };
    const originalConnect = second.conn.connect;
    second.conn.connect = async (url, opts) => {
      order.push("connect-new");
      return originalConnect(url, opts);
    };

    const next = await client.connectSurreal({ ...input, dbName: "ws_999" });

    expect(order).toEqual(["close-old", "connect-new"]);
    expect(next).toBe(second.conn);
    expect(client.getSurreal()).toBe(second.conn);
    expect(second.connectCalls[0].opts).toMatchObject({ database: "ws_999" });
  });

  test("url 为空（VITE_SURREAL_URL 缺失）时抛可诊断错误且不调 factory", async () => {
    let factoryCalled = false;
    const client = createSurrealClient({
      factory: () => {
        factoryCalled = true;
        return fakeSurreal().conn;
      },
    });

    await expect(
      client.connectSurreal({ ...input, url: "" }),
    ).rejects.toThrow("VITE_SURREAL_URL");
    await expect(
      client.connectSurreal({ ...input, url: undefined as unknown as string }),
    ).rejects.toThrow("VITE_SURREAL_URL");
    expect(factoryCalled).toBe(false);
    expect(() => client.getSurreal()).toThrow("Surreal not connected");
  });

  test("未连接时 getSurreal 抛错；closeSurreal 后又抛错且旧连接被 close", async () => {
    const fake = fakeSurreal();
    const client = createSurrealClient({ factory: () => fake.conn });

    expect(() => client.getSurreal()).toThrow("Surreal not connected");

    await client.connectSurreal(input);
    expect(client.getSurreal()).toBe(fake.conn);

    await client.closeSurreal();
    expect(fake.closed).toBe(true);
    expect(() => client.getSurreal()).toThrow("Surreal not connected");
  });
});

describe("浏览器 adapter 的 query / liveTable 透传", () => {
  test("query 把 SurrealQL + bindings 透传给底层 driver 并返回首个结果集", async () => {
    const calls: Array<{ sql: string; bindings: unknown }> = [];
    const rows = [{ id: "ent_x:1", a: 1 }];
    // 模拟 driver：query(sql, bindings).collect() → [resultSet0, ...]
    const rawDriver = {
      query(sql: string, bindings?: Record<string, unknown>) {
        calls.push({ sql, bindings });
        return {
          collect: async () => [rows],
        };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    const result = await conn.query<{ id: string; a: number }>(
      "SELECT * FROM ent_x WHERE a = $a",
      { a: 1 },
    );

    expect(calls).toEqual([{ sql: "SELECT * FROM ent_x WHERE a = $a", bindings: { a: 1 } }]);
    expect(result).toBe(rows);
  });

  test("liveTable 用 Table 包裹表名并等待订阅对象，回调收到 action/value", async () => {
    const subscriptions: unknown[] = [];
    let captured: ((msg: { action: string; value: Record<string, unknown> }) => void) | null = null;
    let unsubscribed = false;
    const rawDriver = {
      live(what: unknown) {
        subscriptions.push(what);
        return Promise.resolve({
          subscribe(handler: (msg: { action: string; value: Record<string, unknown> }) => void) {
            captured = handler;
            return () => {
              unsubscribed = true;
            };
          },
        });
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    const received: Array<{ action: string; value: Record<string, unknown> }> = [];
    const off = await conn.liveTable("ent_x", (msg) => received.push(msg));

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toBeInstanceOf(Table);
    expect(String(subscriptions[0])).toBe("ent_x");
    captured?.({ action: "CREATE", value: { id: "ent_x:1" } });
    expect(received).toEqual([{ action: "CREATE", value: { id: "ent_x:1" } }]);

    off();
    expect(unsubscribed).toBe(true);
  });

  test("updateRecord 用 StringRecordId 包裹 id 并 MERGE patch，返回更新后的记录", async () => {
    const calls: Array<{ id: unknown; patch: unknown }> = [];
    const rawDriver = {
      update(id: unknown) {
        return {
          async merge(patch: unknown) {
            calls.push({ id, patch });
            return { id: "ent_x:1", a: 9 };
          },
        };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    const updated = await conn.updateRecord("ent_x:1", { a: 9 });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].id)).toBe("ent_x:1");
    expect(calls[0].patch).toEqual({ a: 9 });
    expect(updated).toEqual({ id: "ent_x:1", a: 9 });
  });

  test("createRecord 在指定表 content 数据，返回新建记录", async () => {
    const calls: Array<{ table: unknown; data: unknown }> = [];
    const rawDriver = {
      create(table: unknown) {
        return {
          async content(data: unknown) {
            calls.push({ table, data });
            return { id: "ent_x:new", a: 1 };
          },
        };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    const created = await conn.createRecord("ent_x", { a: 1 });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].table)).toBe("ent_x");
    expect(calls[0].data).toEqual({ a: 1 });
    expect(created).toEqual({ id: "ent_x:new", a: 1 });
  });

  test("deleteRecord 用 StringRecordId 包裹 id 并删除", async () => {
    const calls: unknown[] = [];
    const rawDriver = {
      async delete(id: unknown) {
        calls.push(id);
        return { id: "ent_x:1" };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    await conn.deleteRecord("ent_x:1");

    expect(calls).toHaveLength(1);
    expect(String(calls[0])).toBe("ent_x:1");
  });

  test("transaction 用 SDK transaction writer 执行写入，成功后 commit", async () => {
    const calls: Array<{ id: unknown; patch: unknown }> = [];
    let committed = false;
    let cancelled = false;
    const rawDriver = {
      async beginTransaction() {
        return {
          update(id: unknown) {
            return {
              async merge(patch: unknown) {
                calls.push({ id, patch });
                return { id: "ent_x:1", a: 2 };
              },
            };
          },
          create() {
            throw new Error("create should not be called");
          },
          async commit() {
            committed = true;
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    await conn.transaction(async (tx) => {
      await tx.updateRecord("ent_x:1", { a: 2 });
    });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].id)).toBe("ent_x:1");
    expect(calls[0].patch).toEqual({ a: 2 });
    expect(committed).toBe(true);
    expect(cancelled).toBe(false);
  });

  test("transaction 内写入失败时 cancel 且不 commit", async () => {
    let committed = false;
    let cancelled = false;
    const rawDriver = {
      async beginTransaction() {
        return {
          update() {
            return {
              async merge() {
                throw new Error("write failed");
              },
            };
          },
          create() {
            throw new Error("create should not be called");
          },
          async commit() {
            committed = true;
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    };

    const conn = createBrowserConn(rawDriver as never);
    await expect(conn.transaction(async (tx) => {
      await tx.updateRecord("ent_x:1", { a: 2 });
    })).rejects.toThrow("write failed");

    expect(committed).toBe(false);
    expect(cancelled).toBe(true);
  });
});
