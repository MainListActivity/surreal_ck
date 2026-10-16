import { describe, expect, test } from "bun:test";
import {
  callerRunDiagnostics,
  createCallerSession,
  sessionForPhase,
} from "./caller-session";
import {
  AiCallerQueryTimeoutError,
  AiRunCancelledError,
  createRunDiagnostics,
} from "./run-diagnostics";

type FakeSurreal = {
  connected: boolean;
  authenticatedWith?: string;
  used?: { namespace?: string; database?: string };
  connect(url: string): Promise<void>;
  authenticate(token: string): Promise<true>;
  use(opts: { namespace?: string; database?: string }): Promise<void>;
};

function fakeSurreal(opts: { authThrows?: boolean } = {}): FakeSurreal {
  return {
    connected: false,
    async connect() {
      this.connected = true;
    },
    async authenticate(token: string) {
      if (opts.authThrows) throw new Error("There was a problem with authentication");
      this.authenticatedWith = token;
      return true;
    },
    async use(o) {
      this.used = o;
    },
  };
}

describe("createCallerSession", () => {
  test("connect 后用 OIDC token authenticate，得到调用者会话", async () => {
    const fake = fakeSurreal();
    const session = await createCallerSession("oidc-token-xyz", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
    });

    expect(session).toBe(fake as never);
    expect(fake.connected).toBe(true);
    expect(fake.authenticatedWith).toBe("oidc-token-xyz");
    // 不 use()：JWT token 自带 db/ac scope，authenticate 已把会话落到目标 db。
    expect(fake.used).toBeUndefined();
  });

  test("authenticate 被 DB 引擎拒绝时向上抛（由路由翻成 403）", async () => {
    const fake = fakeSurreal({ authThrows: true });
    await expect(
      createCallerSession("bad-token", { surrealUrl: "ws://db/rpc", newSurreal: () => fake as never }),
    ).rejects.toThrow(/authentication/i);
  });
});

// ─── PG-1：连接/查询有界 + 取消联动 + 诊断快照脱敏 ────────────────────────────

type QueryFake = FakeSurreal & {
  queryCalls: Array<{ sql: string; params?: Record<string, unknown> }>;
  closed: boolean;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

function queryableSurreal(queryImpl: QueryFake["query"]): QueryFake {
  const base = fakeSurreal() as QueryFake;
  base.queryCalls = [];
  base.closed = false;
  base.query = async (sql, params) => {
    base.queryCalls.push({ sql, params });
    return queryImpl(sql, params);
  };
  base.close = async () => {
    base.closed = true;
  };
  return base;
}

describe("caller session PG-1 有界与诊断", () => {
  test("永不返回的 connect 在时限内抛 ai-caller-query-timeout，且关连接", async () => {
    const fake = fakeSurreal();
    fake.connect = () => new Promise<void>(() => {});

    const error = await createCallerSession("t", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
      timeouts: { connectTimeoutMs: 20 },
    }).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AiCallerQueryTimeoutError);
    expect((error as AiCallerQueryTimeoutError).code).toBe("ai-caller-query-timeout");
  });

  test("永不返回的 query 在时限内抛超时；快照记 timeout + 语句种类，关连接兜底", async () => {
    const fake = queryableSurreal(() => new Promise(() => {}));
    const session = await createCallerSession("t", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
      timeouts: { queryTimeoutMs: 25 },
    });

    const error = await session.query("SELECT * FROM ent_items", { secretParam: "top-secret-value" })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AiCallerQueryTimeoutError);
    expect(fake.closed).toBe(true);

    const snap = callerRunDiagnostics(session)!.snapshot("timeout");
    const op = snap.completed.find((record) => record.name === "SELECT");
    expect(op?.phase).toBe("query");
    expect(op?.status).toBe("timeout");
    expect(op?.error).toBe("ai-caller-query-timeout");
    // 脱敏：绑定键名保留，参数值不落账。
    expect(op?.argShape).toEqual(["secretParam"]);
    expect(JSON.stringify(snap)).not.toContain("top-secret-value");
    expect(JSON.stringify(snap)).not.toContain("FROM ent_items");
  });

  test("query 正常完成记 ok + 时长；thenable 包装可 await", async () => {
    const fake = queryableSurreal(async () => [[{ id: "r:1" }]]);
    const session = await createCallerSession("t", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
      timeouts: { queryTimeoutMs: 1000 },
    });

    const rows = await session.query("SELECT name FROM person");
    expect(rows).toEqual([[{ id: "r:1" }]]);

    const snap = callerRunDiagnostics(session)!.snapshot("x");
    const op = snap.completed.find((record) => record.name === "SELECT");
    expect(op?.status).toBe("ok");
    expect(typeof op?.durationMs).toBe("number");
  });

  test("run 取消后：业务 query 拒绝派发且不触碰 DB，persist 视图仍放行", async () => {
    const diag = createRunDiagnostics();
    const controller = new AbortController();
    diag.bindRun({ signal: controller.signal, runId: "r1" });

    const fake = queryableSurreal(async () => [[]]);
    const session = await createCallerSession("t", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
      diagnostics: diag,
    });

    controller.abort();

    const businessCallsBefore = fake.queryCalls.length;
    const error = await session.query("UPDATE ent_items SET x = 1")
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AiRunCancelledError);
    expect((error as AiRunCancelledError).code).toBe("ai-run-cancelled");
    expect(fake.queryCalls.length).toBe(businessCallsBefore);

    const persist = sessionForPhase(session, "persist");
    await persist.query("UPDATE workflow_run SET status = 'canceled'");
    const last = fake.queryCalls.at(-1)!;
    expect(last.sql).toContain("workflow_run");

    const snap = diag.snapshot("cancelled");
    const byPhase = new Map(snap.completed.map((record) => [record.phase, record.status]));
    expect(byPhase.get("query")).toBe("cancelled");
    expect(byPhase.get("persist")).toBe("ok");
  });

  test("sessionForPhase 视图把同一 query 记为指定 phase", async () => {
    const fake = queryableSurreal(async () => [[]]);
    const session = await createCallerSession("t", {
      surrealUrl: "ws://db/rpc",
      newSurreal: () => fake as never,
    });

    await sessionForPhase(session, "persist").query("CREATE chat_delivery CONTENT $c", { c: 1 });

    const snap = callerRunDiagnostics(session)!.snapshot("x");
    const op = snap.completed.find((record) => record.name === "CREATE");
    expect(op?.phase).toBe("persist");
    expect(op?.argShape).toEqual(["c"]);
  });
});
