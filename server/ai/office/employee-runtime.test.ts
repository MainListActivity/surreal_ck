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
      rootSession: async () => ({ query: async () => [[{ secret: "from-db" }]] }),
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
    await expect(runtime.register(target("ve-dead"))).rejects.toThrow("no such employee");
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
});
