import { describe, expect, test } from "bun:test";
import { createSurrealClient, type SurrealConn, type SurrealConnectInput } from "./surreal";

type ConnectCall = { url: string; opts: unknown };

function fakeSurreal(overrides: Partial<SurrealConn> = {}) {
  const connectCalls: ConnectCall[] = [];
  const useCalls: unknown[] = [];
  let closed = false;
  let status: SurrealConn["status"] = "disconnected";

  const conn: SurrealConn = {
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
  access: "admin",
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

    const next = await client.connectSurreal({ ...input, dbName: "ws_999", access: "participant" });

    expect(order).toEqual(["close-old", "connect-new"]);
    expect(next).toBe(second.conn);
    expect(client.getSurreal()).toBe(second.conn);
    expect(second.connectCalls[0].opts).toMatchObject({ database: "ws_999" });
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
