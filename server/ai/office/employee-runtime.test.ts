import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { createEmployeeRuntime } from "./employee-runtime";

/** 假 Surreal 连接：记录 connect/signin/close，可注入 signin 失败。 */
function fakeConnect(log: string[], opts: { failSigninFor?: string[] } = {}) {
  const sessions: Array<{ close(): Promise<void> }> = [];
  const connect = () => {
    const session = {
      async connect(url: string, options: Record<string, unknown>) {
        log.push(`connect:${String(options.database)}`);
      },
      async signin(input: { access?: string; variables?: { subject?: string; pass?: string } }) {
        const subject = input.variables?.subject ?? "";
        log.push(`signin:${input.access}:${subject}`);
        if (opts.failSigninFor?.includes(subject)) throw new Error("no such employee");
      },
      async close() { log.push("close"); },
    };
    sessions.push(session);
    return session as unknown as Surreal;
  };
  return { connect, sessions };
}

const target = (subject = "ve-1") => ({
  database: "ws_a",
  employeeId: "user:ve_1",
  subject,
  secret: "s3cret",
});

describe("employee runtime session registry", () => {
  test("register 建立并登记会话；重复注册先关旧会话不留双连接", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main", connect: fakeConnect(log).connect,
    });
    await runtime.register(target());
    expect(runtime.session("ws_a", "user:ve_1")).toBeDefined();
    await runtime.register(target());
    expect(log.filter((l) => l === "close")).toHaveLength(1);
    expect(runtime.activeSessions()).toBe(1);
    await runtime.stop();
  });

  test("并发 register 串行化，结束时只剩一条会话", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main", connect: fakeConnect(log).connect,
    });
    await Promise.all([runtime.register(target()), runtime.register(target()), runtime.register(target())]);
    expect(runtime.activeSessions()).toBe(1);
    await runtime.stop();
  });

  test("close 摘除会话；forgetSecret 丢弃缓存", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main", connect: fakeConnect(log).connect,
      rootSession: async () => ({ query: async () => [[{ secret: "from-db", subject: "ve-1" }]] }),
    });
    await runtime.register(target());
    expect(await runtime.secretFor("ws_a", "user:ve_1")).toBe("s3cret");
    await runtime.close("ws_a", "user:ve_1", { forgetSecret: true });
    expect(runtime.session("ws_a", "user:ve_1")).toBeUndefined();
    // 缓存被清后 secretFor 回源 root
    expect(await runtime.secretFor("ws_a", "user:ve_1")).toBe("from-db");
    await runtime.stop();
  });

  test("SIGNIN 失败（员工非 active）抛出且不登记会话", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: fakeConnect(log, { failSigninFor: ["ve-dead"] }).connect,
    });
    await expect(runtime.register(target("ve-dead"))).rejects.toThrow("employee-signin-failed");
    expect(runtime.session("ws_a", "user:ve_1")).toBeUndefined();
    expect(runtime.activeSessions()).toBe(0);
    await runtime.stop();
  });

  test("warmup 遍历 active workspace 回装凭证缓存（不开会话）", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main", connect: fakeConnect(log).connect,
      systemSession: async () => ({
        query: async () => [[{ db_name: "ws_a" }, { db_name: "ws_b" }, { db_name: null }]],
      }),
      rootSession: async (database) => ({
        query: async () =>
          database === "ws_a"
            ? [[{ employee: "user:ve_1", secret: "sec-a", subject: "ve-1" }]]
            : [[{ employee: "user:ve_9", secret: "sec-b", subject: "ve-9" }]],
      }),
    });
    const stats = await runtime.warmup();
    expect(stats).toEqual({ databases: 3, credentials: 2 });
    expect(await runtime.secretFor("ws_a", "user:ve_1")).toBe("sec-a");
    expect(await runtime.secretFor("ws_b", "user:ve_9")).toBe("sec-b");
    expect(log.filter((l) => l.startsWith("connect:"))).toHaveLength(0);
    await runtime.stop();
  });

  test("stop 后 register 拒绝", async () => {
    const runtime = createEmployeeRuntime({ surrealUrl: "wss://x", namespace: "main" });
    await runtime.stop();
    await expect(runtime.register(target())).rejects.toThrow("employee-runtime-stopped");
  });

  test("openSession 回源 employee_credential 后 SIGNIN 并返回会话", async () => {
    const log: string[] = [];
    const rootQueries: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: fakeConnect(log).connect,
      rootSession: async () => ({
        query: async (sql: string) => {
          rootQueries.push(sql);
          return [[{ secret: "db-secret", subject: "ve-1" }]];
        },
      }),
    });
    const session = await runtime.openSession("ws_a", "user:ve_1");
    expect(session).toBe(runtime.session("ws_a", "user:ve_1"));
    expect(log).toEqual(["connect:ws_a", "signin:employee:ve-1"]);
    expect(rootQueries.join("")).toContain("employee_credential");
    // 已注册连接直接复用：不重新 SIGNIN，也不触发窗口失效通知
    const again = await runtime.openSession("ws_a", "user:ve_1");
    expect(rootQueries).toHaveLength(1);
    expect(again).toBe(session);
    expect(log.filter((l) => l === "signin:employee:ve-1")).toHaveLength(1);
    await runtime.stop();
  });

  test("openSession 拿不到凭证时拒绝且不留会话", async () => {
    const log: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: fakeConnect(log).connect,
      rootSession: async () => ({ query: async () => [[]] }),
    });
    await expect(runtime.openSession("ws_a", "user:ve_1"))
      .rejects.toThrow("employee-credential-missing");
    expect(runtime.activeSessions()).toBe(0);
    expect(log).toHaveLength(0);
    await runtime.stop();
  });
});

/**
 * 带事件支持的假连接：记录 connect/signin/close 与订阅的监听器，
 * 供 VER06 会话监督测试触发 reconnecting/disconnected/auth 事件。
 */
function fakeSupervisedConnect(log: string[]) {
  type Listener = (...args: unknown[]) => void;
  const made: Array<{
    listeners: Map<string, Listener[]>;
    signins: string[];
    emit(event: string, ...args: unknown[]): void;
  }> = [];
  const connect = () => {
    const listeners = new Map<string, Listener[]>();
    const signins: string[] = [];
    const session = {
      async connect(_url: string, options: Record<string, unknown>) {
        log.push(`connect:${String(options.database)}`);
      },
      async signin(input: { access?: string; variables?: { subject?: string } }) {
        signins.push(String(input.variables?.subject ?? ""));
        log.push(`signin:${input.access}:${input.variables?.subject}`);
      },
      subscribe(event: string, cb: Listener) {
        const arr = listeners.get(event) ?? [];
        arr.push(cb);
        listeners.set(event, arr);
        return () => undefined;
      },
      async close() {
        log.push("close");
      },
    };
    made.push({
      listeners,
      signins,
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners.get(event) ?? []) cb(...args);
      },
    });
    return session as unknown as Surreal;
  };
  return { connect, made };
}

/** 虚拟时钟调度器：与 trigger-runtime 测试同款的确定性计时 seam。 */
function fakeScheduler() {
  let epoch = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    schedule: (fn: () => void, ms: number) => {
      id += 1;
      timers.set(id, { at: epoch + ms, fn });
      return id;
    },
    cancel: (handle: unknown) => {
      timers.delete(handle as number);
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        clock.schedule(resolve, ms);
      }),
    pending: () => timers.size,
    async advance(ms: number) {
      const target = epoch + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [tid, timer] = due[0]!;
        epoch = Math.max(epoch, timer.at);
        timers.delete(tid);
        timer.fn();
        for (let i = 0; i < 10; i += 1) await Bun.sleep(0);
      }
      epoch = target;
      for (let i = 0; i < 10; i += 1) await Bun.sleep(0);
    },
  };
  return clock;
}

describe("employee runtime 会话监督（VER06）", () => {
  test("connect 携带 SDK 自动重连配置（enabled，无限重试）", async () => {
    const log: string[] = [];
    const options: Record<string, unknown>[] = [];
    const base = fakeSupervisedConnect(log);
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: () => {
        const s = base.connect();
        const orig = s.connect.bind(s);
        s.connect = async (url: string, o: Record<string, unknown>) => {
          options.push(o);
          return orig(url, o);
        };
        return s;
      },
    });
    await runtime.register(target());
    const reconnect = options[0]?.reconnect as { enabled?: boolean; attempts?: number };
    expect(reconnect?.enabled).toBe(true);
    expect(reconnect?.attempts).toBe(-1);
    await runtime.stop();
  });

  test("到期前续约：定时器到点在同一连接上重签，不产生第二条连接或重复监听", async () => {
    const log: string[] = [];
    const base = fakeSupervisedConnect(log);
    const clock = fakeScheduler();
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: base.connect,
      renewAfterMs: 1_000,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
    });
    await runtime.register(target());
    const entry = base.made[0]!;
    expect(entry.signins).toEqual(["ve-1"]);
    expect(base.made).toHaveLength(1);

    await clock.advance(1_000); // 续约点
    expect(entry.signins).toEqual(["ve-1", "ve-1"]);
    expect(base.made).toHaveLength(1); // 无第二条连接
    expect(runtime.activeSessions()).toBe(1);
    expect(entry.listeners.get("auth")).toHaveLength(1); // 监听仍只有一组

    await clock.advance(1_000); // 再续约
    expect(entry.signins).toEqual(["ve-1", "ve-1", "ve-1"]);
    expect(runtime.sessionStats().renewals).toBe(2);
    await runtime.stop();
    await clock.advance(5_000); // stop 后不再续约
    expect(entry.signins).toHaveLength(3);
  });

  test("auth(null) 失效事件 → 立即用缓存凭证重签", async () => {
    const log: string[] = [];
    const base = fakeSupervisedConnect(log);
    const clock = fakeScheduler();
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: base.connect,
      renewAfterMs: 60_000,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
    });
    await runtime.register(target());
    const entry = base.made[0]!;
    entry.emit("auth", null); // token 失效
    for (let i = 0; i < 10; i += 1) await Bun.sleep(0);
    expect(entry.signins).toEqual(["ve-1", "ve-1"]);
    const stats = runtime.sessionStats();
    expect(stats.invalidated).toBe(1);
    expect(stats.renewals).toBe(1);
    await runtime.stop();
  });

  test("reconnecting/disconnected 事件计入 stats；stats 与日志不含 secret", async () => {
    const log: string[] = [];
    const base = fakeSupervisedConnect(log);
    const clock = fakeScheduler();
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: base.connect,
      renewAfterMs: 60_000,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
    });
    await runtime.register(target());
    const entry = base.made[0]!;
    entry.emit("disconnected");
    entry.emit("reconnecting");
    entry.emit("reconnecting");
    const stats = runtime.sessionStats();
    expect(stats).toMatchObject({
      activeSessions: 1,
      connects: 1,
      disconnects: 1,
      reconnects: 2,
      renewals: 0,
      renewalFailures: 0,
      invalidated: 0,
    });
    expect(JSON.stringify(stats)).not.toContain("s3cret");
    await runtime.stop();
  });

  test("续约 transient 失败走有界重试；最终失败计入 renewalFailures 但会话仍在", async () => {
    const log: string[] = [];
    const base = fakeSupervisedConnect(log);
    const clock = fakeScheduler();
    let failSignin = false;
    const runtime = createEmployeeRuntime({
      surrealUrl: "wss://x", namespace: "main",
      connect: () => {
        const s = base.connect();
        const orig = s.signin.bind(s);
        s.signin = async (input: { access?: string; variables?: { subject?: string; pass?: string } }) => {
          if (failSignin) throw new Error("connection reset by peer");
          return orig(input);
        };
        return s;
      },
      renewAfterMs: 1_000,
      schedule: clock.schedule,
      cancelScheduled: clock.cancel,
      retry: {
        sleep: clock.sleep,
        policy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200, jitterRatio: 0 },
      },
    });
    await runtime.register(target());
    const entry = base.made[0]!;
    failSignin = true;
    await clock.advance(1_000); // 续约点：第 1 次失败 → 100ms 退避 → 第 2 次失败 → 放弃
    await clock.advance(200);
    expect(entry.signins).toHaveLength(1);
    expect(runtime.sessionStats().renewalFailures).toBe(1);
    expect(runtime.activeSessions()).toBe(1); // 会话仍挂着，等下轮续约兜底

    failSignin = false;
    await clock.advance(1_000); // 下一轮续约恢复
    expect(entry.signins).toHaveLength(2);
    expect(runtime.sessionStats().renewals).toBe(1);
    await runtime.stop();
  });
});
