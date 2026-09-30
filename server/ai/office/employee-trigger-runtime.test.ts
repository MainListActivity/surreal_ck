import { describe, expect, test } from "bun:test";
import {
  createEmployeeTriggerRuntime,
  type TriggerDelivery,
  type TriggerSessionManager,
} from "./employee-trigger-runtime";

type Row = Record<string, unknown> & { id: string; status: string };

type FakeDb = { rows: Map<string, Row>; byId: Map<string, Row>; counter: number };

/**
 * 内存版员工会话：按 db 隔离 employee_trigger 行，模拟幂等键唯一索引
 * （重复 INSERT 撞键时返回既有行，不再产生第二行）。
 */
function fakeSessions() {
  const log: string[] = [];
  const databases = new Map<string, FakeDb>();
  const db = (name: string): FakeDb => {
    let entry = databases.get(name);
    if (!entry) {
      entry = { rows: new Map(), byId: new Map(), counter: 0 };
      databases.set(name, entry);
    }
    return entry;
  };
  const sessions: TriggerSessionManager = {
    async openSession(database, employeeId) {
      log.push(`open:${database}::${employeeId}`);
      const store = db(database);
      return {
        async query(sql: string, params: Record<string, unknown> = {}) {
          if (sql.includes("INSERT INTO employee_trigger")) {
            const content = params.content as Record<string, unknown>;
            const key = String(content.idempotency_key);
            const existing = store.rows.get(key);
            if (existing) return [[existing]];
            store.counter += 1;
            const row: Row = { id: `employee_trigger:t${store.counter}`, ...content } as Row;
            store.rows.set(key, row);
            store.byId.set(row.id, row);
            return [[row]];
          }
          if (sql.includes("UPDATE $trigger")) {
            const row = store.byId.get(String(params.trigger));
            if (row) {
              row.status = String(params.status);
              if ("message" in params) row.error_message = params.message;
              if ("result" in params) row.result = params.result;
            }
            return [[]];
          }
          return [[]];
        },
      };
    },
    async close(database, employeeId) {
      log.push(`close:${database}::${employeeId}`);
    },
  };
  return { sessions, log, databases };
}

const delivery = (overrides: Partial<TriggerDelivery> = {}): TriggerDelivery => ({
  database: "ws_a",
  employeeId: "user:ve_1",
  reason: "daily-claims-risk",
  payloadRef: "2026-09-30",
  chainDepth: 0,
  idempotencyKey: "daily-claims-risk:user:ve_1:2026-09-30",
  ...overrides,
});

describe("employee trigger runtime", () => {
  test("enqueue 先持久化触发再以员工会话执行窗口，完成后落结果并关会话", async () => {
    const { sessions, log, databases } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    const seen: string[] = [];
    runtime.registerHandler("daily-claims-risk", async ({ trigger, session }) => {
      seen.push(`handler:${trigger.id}:${trigger.payloadRef}`);
      await session.query("INSERT INTO effect SET x = 1");
      return { status: "completed", remindersCreated: 2 };
    });

    const result = await runtime.enqueue(delivery());
    expect(result).toEqual({ outcome: "completed", triggerId: "employee_trigger:t1" });
    expect(seen).toEqual(["handler:employee_trigger:t1:2026-09-30"]);

    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    expect(row.status).toBe("completed");
    expect(row.reason).toBe("daily-claims-risk");
    expect(row.payload_ref).toBe("2026-09-30");
    expect(row.chain_depth).toBe(0);
    expect(row.result).toEqual({ status: "completed", remindersCreated: 2 });
    expect(log).toEqual(["open:ws_a::user:ve_1", "close:ws_a::user:ve_1"]);
    await runtime.stop();
  });

  test("同一幂等键重复投递：运行中共享窗口，完成后返回 coalesced，handler 只跑一次", async () => {
    const { sessions, databases } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    let calls = 0;
    let release: (() => void) | undefined;
    const windowOpened = new Promise<void>((resolve) => {
      runtime.registerHandler("daily-claims-risk", async () => {
        calls += 1;
        resolve();
        await new Promise<void>((r) => { release = r; });
      });
    });

    const first = runtime.enqueue(delivery());
    const second = runtime.enqueue(delivery());
    await windowOpened;
    release!();
    expect(await first).toMatchObject({ outcome: "completed" });
    // 第二个投递在窗口后到达：触发已 completed，直接收敛
    expect(await second).toMatchObject({ outcome: "coalesced" });
    expect(calls).toBe(1);
    expect(databases.get("ws_a")!.rows.size).toBe(1);

    // 第三次投递同样收敛
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "coalesced" });
    expect(calls).toBe(1);
    await runtime.stop();
  });

  test("handler 抛错：触发落 failed 并保留错误信息，会话关闭", async () => {
    const { sessions, databases, log } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => {
      throw new Error("workspace store exploded");
    });
    const result = await runtime.enqueue(delivery());
    expect(result.outcome).toBe("failed");
    const row = [...databases.get("ws_a")!.rows.values()][0]!;
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("workspace store exploded");
    expect(log.filter((l) => l.startsWith("close:"))).toHaveLength(1);
    await runtime.stop();
  });

  test("未注册 reason 的触发落 failed", async () => {
    const { sessions, databases } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "failed", error: "no-handler:daily-claims-risk" });
    expect([...databases.get("ws_a")!.rows.values()][0]?.status).toBe("failed");
    await runtime.stop();
  });

  test("同一员工的触发串行执行，不同员工互不阻塞", async () => {
    const { sessions } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    const order: string[] = [];
    runtime.registerHandler("daily-claims-risk", async ({ trigger }) => {
      order.push(`begin:${trigger.idempotencyKey}`);
      await Bun.sleep(10);
      order.push(`end:${trigger.idempotencyKey}`);
    });
    const a1 = runtime.enqueue(delivery({ idempotencyKey: "k-a1" }));
    const a2 = runtime.enqueue(delivery({ idempotencyKey: "k-a2" }));
    const b1 = runtime.enqueue(delivery({
      database: "ws_b", employeeId: "user:ve_2", idempotencyKey: "k-b1",
    }));
    await Promise.all([a1, a2, b1]);
    const aBegin = order.indexOf("begin:k-a2");
    const a1End = order.indexOf("end:k-a1");
    expect(aBegin).toBeGreaterThan(a1End);
    await runtime.stop();
  });

  test("start 前与 stop 后都拒绝新投递；stop 排空在途窗口并关闭会话", async () => {
    const { sessions, log } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions });
    await expect(runtime.enqueue(delivery())).rejects.toThrow("employee-trigger-runtime-stopped");

    runtime.start();
    let release: (() => void) | undefined;
    const windowOpened = new Promise<void>((resolve) => {
      runtime.registerHandler("daily-claims-risk", async () => {
        resolve();
        await new Promise<void>((r) => { release = r; });
      });
    });
    const inflight = runtime.enqueue(delivery());
    await windowOpened;
    const stopping = runtime.stop();
    await expect(runtime.enqueue(delivery({ idempotencyKey: "late" })))
      .rejects.toThrow("employee-trigger-runtime-stopped");
    release!();
    await stopping;
    expect(await inflight).toMatchObject({ outcome: "completed" });
    expect(log).toContain("close:ws_a::user:ve_1");
  });

  test("会话打开失败（员工暂停/凭证缺失）返回 failed 且不写触发", async () => {
    const sessions: TriggerSessionManager = {
      async openSession() { throw new Error("no such employee"); },
      async close() {},
    };
    const runtime = createEmployeeTriggerRuntime({ sessions });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({}));
    const result = await runtime.enqueue(delivery());
    expect(result).toEqual({ outcome: "failed", error: "no such employee" });
    await runtime.stop();
  });

  test("runtime 触发的所有查询只落到 employee_trigger，不碰办公室领域表", async () => {
    const { sessions } = fakeSessions();
    const seen: string[] = [];
    const spying: TriggerSessionManager = {
      async openSession(database, employeeId) {
        const inner = await sessions.openSession(database, employeeId);
        return {
          query(sql, params) {
            seen.push(sql);
            return inner.query(sql, params);
          },
        };
      },
      close: (database, employeeId) => sessions.close(database, employeeId),
    };
    const runtime = createEmployeeTriggerRuntime({ sessions: spying });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    await runtime.enqueue(delivery());
    const all = seen.join("\n");
    expect(all).toContain("employee_trigger");
    expect(all).not.toMatch(/office_task|office_message|office_report|office_goal/);
    await runtime.stop();
  });
});
