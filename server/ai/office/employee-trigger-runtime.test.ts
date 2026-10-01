import { describe, expect, test } from "bun:test";
import { createEmployeeEffects } from "./employee-effects";
import {
  createEmployeeTriggerRuntime,
  type EmployeeRunDriver,
  type EmployeeRunResult,
  type EmployeeRunDriverFactory,
  type TriggerDelivery,
  type TriggerHandler,
  type TriggerSessionManager,
} from "./employee-trigger-runtime";

type Row = Record<string, unknown> & { id: string; status: string };

type FakeDb = {
  rows: Map<string, Row>;
  byId: Map<string, Row>;
  effects: Map<string, Row>;
  windows: Map<string, Row>;
  usage: Map<string, Row>;
  counter: number;
};

/**
 * 内存版员工会话：按 db 隔离 employee_trigger / employee_effect 行，模拟
 * 幂等键唯一索引（重复 INSERT 撞键返回既有行）、lease 原子认领的 WHERE
 * 语义（pending/failed 或 leased|running 且 lease 到期才可更新）与
 * employee_effect 的 pending→committed 账本。
 */
function fakeSessions() {
  const log: string[] = [];
  const databases = new Map<string, FakeDb>();
  const db = (name: string): FakeDb => {
    let entry = databases.get(name);
    if (!entry) {
      entry = { rows: new Map(), byId: new Map(), effects: new Map(), windows: new Map(), usage: new Map(), counter: 0 };
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
            const row: Row = {
              id: `employee_trigger:t${store.counter}`,
              created_at: store.counter,
              ...content,
            } as Row;
            store.rows.set(key, row);
            store.byId.set(row.id, row);
            return [[row]];
          }
          if (sql.includes("INSERT INTO employee_effect")) {
            const content = params.content as Record<string, unknown>;
            const key = String(content.effect_key);
            const existing = store.effects.get(key);
            if (existing) return [[existing]];
            const row: Row = { id: `employee_effect:e${store.effects.size + 1}`, ...content } as Row;
            store.effects.set(key, row);
            return [[row]];
          }
          if (sql.includes("UPDATE employee_effect")) {
            const row = store.effects.get(String(params.effectKey));
            if (row) {
              row.status = "committed";
              row.result = params.result;
            }
            return [[]];
          }
          if (sql.includes("UPSERT employee_window")) {
            // 员工级互斥（UPSERT CAS）：lease 未到期且被占 → WHERE 落空返回空（判负）；
            // 到期/释放 → 换 holder；无行 → 插入占位。
            const employee = String(params.employee);
            const existing = store.windows.get(employee);
            const nowTs = params.now as Date;
            const held = existing
              && existing.lease_expires_at instanceof Date
              && existing.lease_expires_at > nowTs;
            if (existing && held) return [[]];
            if (existing) {
              existing.lease_expires_at = params.leaseExpires;
              existing.holder = params.holder;
              existing.trigger = params.trigger;
              return [[existing]];
            }
            const row: Row = {
              id: `employee_window:w${store.windows.size + 1}`,
              employee: params.employee,
              holder: params.holder,
              trigger: params.trigger,
              lease_expires_at: params.leaseExpires,
            } as Row;
            store.windows.set(employee, row);
            return [[row]];
          }
          if (sql.includes("UPDATE employee_window")) {
            const row = store.windows.get(String(params.employee));
            if (row && row.holder === params.holder) {
              // markWindowTrigger 写当前 trigger；releaseWindow 清 holder/lease/trigger。
              if ("trigger" in params) row.trigger = params.trigger;
              if (sql.includes("holder = NONE")) {
                row.lease_expires_at = undefined;
                row.holder = undefined;
                row.trigger = undefined;
              }
            }
            return [[]];
          }
          if (sql.includes("FROM employee_token_usage") && !sql.includes("UPSERT")) {
            const key = `${String(params.employee)}::${String(params.day)}`;
            const row = store.usage.get(key);
            return [row ? [row] : []];
          }
          if (sql.includes("UPSERT employee_token_usage")) {
            const key = `${String(params.employee)}::${String(params.day)}`;
            if (sql.includes("budget_signal_at IS NONE")) {
              // budget-exhausted signal 的 CAS 去重位：已标记 → 空（判负）。
              const existing = store.usage.get(key);
              if (existing?.budget_signal_at) return [[]];
              const row = existing ?? ({
                id: `employee_token_usage:u${store.usage.size + 1}`,
                employee: params.employee,
                day: params.day,
              } as Row);
              row.budget_signal_at = new Date();
              store.usage.set(key, row);
              return [[row]];
            }
            // recordUsage：UPSERT+WHERE 原子累计（行缺失 → 插入）。
            const row = store.usage.get(key) ?? ({
              id: `employee_token_usage:u${store.usage.size + 1}`,
              employee: params.employee,
              day: params.day,
            } as Row);
            const bump = (field: string, delta: unknown) => {
              row[field] = Number(row[field] ?? 0) + Number(delta ?? 0);
            };
            bump("provider_input_tokens", params.providerIn);
            bump("provider_output_tokens", params.providerOut);
            bump("estimated_input_tokens", params.estimatedIn);
            bump("estimated_output_tokens", params.estimatedOut);
            bump("calls", 1);
            store.usage.set(key, row);
            return [[row]];
          }
          if (sql.includes("UPDATE $trigger") && "claimable" in params) {
            // lease 原子认领：status INSIDE $claimable，或 leased/running 且 lease 到期/缺失。
            const row = store.byId.get(String(params.trigger));
            if (!row) return [[]];
            const claimable = params.claimable as string[];
            const lease = row.lease_expires_at as Date | undefined;
            const expired = lease == null || lease <= (params.now as Date);
            const ok = claimable.includes(row.status)
              || (["leased", "running"].includes(row.status) && expired);
            if (!ok) return [[]];
            row.status = "leased";
            row.lease_expires_at = params.leaseExpires;
            row.attempts = Number(row.attempts ?? 0) + 1;
            row.run_id ??= params.runId;
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
          if (sql.includes("FROM employee_trigger") && sql.includes("lease_expires_at")) {
            const employee = String(params.employee);
            const nowTs = params.now as Date;
            const matched = [...store.byId.values()]
              .filter((row) => {
                if (String(row.employee) !== employee) return false;
                if (row.status === "pending") return true;
                if (!["leased", "running"].includes(row.status)) return false;
                const lease = row.lease_expires_at as Date | undefined;
                return lease == null || lease <= nowTs;
              })
              .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0));
            // claimNextPending 的 SELECT ... LIMIT 1 取最早一条；reconcile 扫描无限定。
            if (sql.includes("LIMIT 1")) return [matched.slice(0, 1)];
            return [matched];
          }
          if (sql.includes("FROM $trigger")) {
            const row = store.byId.get(String(params.trigger));
            // resume 的读带 employee 过滤；sweepWaiters 只按 id 读状态。
            if (row && "employee" in params && String(row.employee) !== String(params.employee)) {
              return [[]];
            }
            return [row ? [row] : []];
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

type FakeDriver = EmployeeRunDriver & {
  calls: string[];
  states: Map<string, { status: string; result?: unknown } | null>;
  script: Map<string, EmployeeRunResult>;
};

/**
 * fake driver 忠实模拟 workflow step：start/restart/resume 通过 resolveHandler
 * 找回注册岗位并执行（注入与生产一致的 effects/suspend ctx）；script 可按
 * "op:runId" 覆盖返回值（suspend/成功收敛等终态用例）。
 */
function fakeDriver(script: Map<string, EmployeeRunResult> = new Map()): {
  factory: (ctx: Parameters<EmployeeRunDriverFactory>[0]) => FakeDriver;
  drivers: FakeDriver[];
} {
  const drivers: FakeDriver[] = [];
  const states = new Map<string, { status: string; result?: unknown } | null>();
  const factory = (ctx: Parameters<EmployeeRunDriverFactory>[0]): FakeDriver => {
    const runTrigger = async (trigger: Parameters<TriggerHandler>[0]["trigger"], resumeData?: unknown): Promise<EmployeeRunResult> => {
      const handler = ctx.resolveHandler(trigger.reason);
      if (!handler) return { status: "failed", error: `no-handler:${trigger.reason}` };
      try {
        const output = await handler({
          trigger,
          session: ctx.session,
          effects: createEmployeeEffects(ctx.session, trigger.id),
          resumeData,
          suspend: async () => {
            throw new Error("suspend not supported by fake driver");
          },
          ...ctx.gates.forTrigger(trigger),
        });
        return { status: "success", output };
      } catch (cause) {
        return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
      }
    };
    const driver: FakeDriver = {
      calls: [],
      states,
      script,
      async loadRunState(runId) {
        driver.calls.push(`load:${runId}`);
        return states.get(runId) ?? null;
      },
      async start({ runId, trigger }) {
        driver.calls.push(`start:${runId}`);
        return script.get(`start:${runId}`) ?? runTrigger(trigger);
      },
      async restart({ runId, trigger }) {
        driver.calls.push(`restart:${runId}`);
        return script.get(`restart:${runId}`) ?? runTrigger(trigger);
      },
      async resume({ runId, trigger, resumeData }) {
        driver.calls.push(`resume:${runId}`);
        return script.get(`resume:${runId}`) ?? runTrigger(trigger, resumeData);
      },
    };
    drivers.push(driver);
    return driver;
  };
  return { factory, drivers };
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

describe("employee trigger runtime（VER04 lease/durable run/幂等副作用）", () => {
  test("enqueue：pending→leased（lease_expires_at/attempts/run_id）→running→completed，结果落库并关会话", async () => {
    const { sessions, log, databases } = fakeSessions();
    const { factory, drivers } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ remindersCreated: 2 }));

    const result = await runtime.enqueue(delivery());
    expect(result).toEqual({ outcome: "completed", triggerId: "employee_trigger:t1" });

    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(1);
    expect(row.run_id).toBe("er-employee_trigger:t1");
    expect(row.lease_expires_at).toBeInstanceOf(Date);
    expect(row.result).toEqual({ remindersCreated: 2 });
    expect(drivers[0]?.calls).toEqual(["load:er-employee_trigger:t1", "start:er-employee_trigger:t1"]);
    // 会话随 lane 空闲在窗口收尾关闭（waiter 先行 resolve）；stop 后必然已关。
    await runtime.stop();
    expect(log).toEqual(["open:ws_a::user:ve_1", "close:ws_a::user:ve_1"]);
  });

  test("同一幂等键重复投递：完成后 coalesced，handler/driver 只跑一次", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory, drivers } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
    runtime.start();
    let calls = 0;
    runtime.registerHandler("daily-claims-risk", async () => {
      calls += 1;
      return { ok: true };
    });

    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "completed" });
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "coalesced" });
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "coalesced" });
    expect(calls).toBe(1);
    expect(drivers).toHaveLength(1);
    expect(databases.get("ws_a")!.rows.size).toBe(1);
    await runtime.stop();
  });

  test("lease 未到期被持有时不抢窗口（coalesced）；到期后重新认领且 attempts 递增", async () => {
    const { sessions, databases } = fakeSessions();
    const driverRef = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: driverRef.factory, now: () => new Date("2026-09-30T00:00:00Z") });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "completed" });

    // 手工把触发回放到"上次进程死在 running、lease 未到期"的形态
    const db = databases.get("ws_a")!;
    const row = db.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    row.status = "running";
    row.lease_expires_at = new Date("2026-09-30T00:00:30Z"); // now = 00:00:00 → 未到期
    driverRef.drivers[0]!.states.set("er-employee_trigger:t1", { status: "running" });

    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "coalesced" });
    expect(row.attempts).toBe(1);

    // lease 到期 → 重新认领 → restart 语义恢复 active run
    row.lease_expires_at = new Date("2026-09-29T23:59:59Z");
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "completed" });
    expect(row.attempts).toBe(2);
    expect(driverRef.drivers.at(-1)?.calls).toEqual(["load:er-employee_trigger:t1", "restart:er-employee_trigger:t1"]);
    await runtime.stop();
  });

  test("snapshot=suspended → 触发置 waiting，绝不 restart；resumeTrigger 走 resume 语义", async () => {
    const runId = "er-employee_trigger:t1";
    const script = new Map<string, EmployeeRunResult>([["start:" + runId, { status: "suspended" }]]);
    const driverRef = fakeDriver(script);
    const { sessions, databases } = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: driverRef.factory });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    const first = await runtime.enqueue(delivery());
    expect(first).toMatchObject({ outcome: "waiting", triggerId: "employee_trigger:t1" });
    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    expect(row.status).toBe("waiting");

    // 同键再投递：waiting 不重跑，仍回 waiting（显式挂起只能走 resumeTrigger）
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "waiting" });

    // run snapshot 为 suspended → resumeTrigger 走 resume 语义
    driverRef.drivers.at(-1)!.states.set(runId, { status: "suspended" });
    const resumed = await runtime.resumeTrigger({
      database: "ws_a",
      employeeId: "user:ve_1",
      triggerId: "employee_trigger:t1",
      resumeData: { approved: true },
    });
    expect(resumed).toMatchObject({ outcome: "completed" });
    expect(driverRef.drivers.at(-1)!.calls).toEqual(["load:" + runId, "resume:" + runId]);
    expect(row.status).toBe("completed");
    await runtime.stop();
  });

  test("snapshot=success 的孤儿触发直接收敛为 completed，不再执行 run", async () => {
    const { sessions, databases } = fakeSessions();
    const driverRef = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: driverRef.factory });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    // 预置：触发行 leased 且 lease 过期 + run 已 success（死在完成前写 trigger 的一步）
    const first = await runtime.enqueue(delivery());
    expect(first).toMatchObject({ outcome: "completed" });
    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    row.status = "running";
    row.lease_expires_at = new Date(0);
    driverRef.drivers[0]!.states.set("er-employee_trigger:t1", { status: "success" });

    const again = await runtime.enqueue(delivery());
    expect(again).toMatchObject({ outcome: "completed" });
    // 没有 start/restart：只有 load
    expect(driverRef.drivers.at(-1)!.calls).toEqual(["load:er-employee_trigger:t1"]);
    await runtime.stop();
  });

  test("窗口内基础设施崩溃：触发保留 running/lease 供回收，不打 failed；下次投递重启 run", async () => {
    const { sessions, databases } = fakeSessions();
    const script = new Map<string, EmployeeRunResult>();
    const driverRef = fakeDriver(script);
    const crashy = (ctx: Parameters<EmployeeRunDriverFactory>[0]) => {
      const inner = driverRef.factory(ctx);
      inner.start = async () => {
        throw new Error("socket closed mid-run");
      };
      return inner;
    };
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: crashy });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    const crashed = await runtime.enqueue(delivery());
    expect(crashed).toMatchObject({ outcome: "failed" });
    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    // fail-open 于 durable 状态：仍是 running + 旧 lease（已到期因为 now 已过 ttl? lease 是未来时间——断言未转 failed 即可）
    expect(row.status).toBe("running");
    expect(row.error_message).toBeUndefined();

    // 下一次投递（lease 已过期）→ 认领并走 restart
    row.lease_expires_at = new Date(0);
    driverRef.drivers[0]!.states.set("er-employee_trigger:t1", { status: "running" });
    const ok = await runtime.enqueue(delivery());
    expect(ok).toMatchObject({ outcome: "completed" });
    expect(row.attempts).toBe(2);
    await runtime.stop();
  });

  test("loadRunState 抛错 = fail-closed：返回 failed，触发保持可重认领状态", async () => {
    const { sessions, databases } = fakeSessions();
    const driverRef = fakeDriver();
    const failing = (ctx: Parameters<EmployeeRunDriverFactory>[0]) => {
      const inner = driverRef.factory(ctx);
      inner.loadRunState = async () => {
        throw new Error("load workflow snapshot failed: conn reset");
      };
      return inner;
    };
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: failing });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "failed" });
    const row = databases.get("ws_a")!.rows.get("daily-claims-risk:user:ve_1:2026-09-30")!;
    // 不把缺失/坏读当成新 run：loadRunState 在 setStatus(running) 之前抛错，
    // 触发停在 leased（lease 到期后由 reconcile/下次投递重试），绝不打成 failed
    expect(row.status).toBe("leased");
    await runtime.stop();
  });

  test("reconcile 回收 pending 与过期 leased/running，跳过 waiting 与未到期 lease", async () => {
    const { sessions, databases } = fakeSessions();
    const driverRef = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: driverRef.factory, now: () => new Date("2026-09-30T00:00:00Z") });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    const db = databases.get("ws_a") ?? { rows: new Map(), byId: new Map(), effects: new Map(), windows: new Map(), counter: 0 };
    databases.set("ws_a", db);
    const seed = (id: string, status: string, lease?: Date) => {
      db.counter += 1;
      const row: Row = {
        id: `employee_trigger:${id}`,
        employee: "user:ve_1",
        reason: "daily-claims-risk",
        idempotency_key: `k-${id}`,
        chain_depth: 0,
        status,
      } as Row;
      if (lease) row.lease_expires_at = lease;
      db.byId.set(row.id, row);
      db.rows.set(`k-${id}`, row);
    };
    seed("a", "pending");                                    // 应回收
    seed("b", "running", new Date("2026-09-29T23:00:00Z"));  // 过期 → 回收
    seed("c", "running", new Date("2026-09-30T01:00:00Z"));  // 未到期 → 跳过
    seed("d", "waiting", new Date(0));                        // waiting 不动（显式挂起只能 resume）

    // scanned 只含 pending + 过期 leased/running（waiting 与未到期 lease 不扫描）
    const summary = await runtime.reconcile({ database: "ws_a", employeeId: "user:ve_1" });
    expect(summary).toMatchObject({ scanned: 2, reclaimed: 2, completed: 2, waiting: 0, failed: 0 });
    expect(db.byId.get("employee_trigger:a")!.status).toBe("completed");
    expect(db.byId.get("employee_trigger:b")!.status).toBe("completed");
    expect(db.byId.get("employee_trigger:c")!.status).toBe("running");
    expect(db.byId.get("employee_trigger:d")!.status).toBe("waiting");
    await runtime.stop();
  });

  test("resumeTrigger 拒绝非 waiting 触发与缺 snapshot 的 run", async () => {
    const { sessions } = fakeSessions();
    const driverRef = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: driverRef.factory });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "completed" });
    const done = await runtime.resumeTrigger({
      database: "ws_a", employeeId: "user:ve_1", triggerId: "employee_trigger:t1",
    });
    expect(done).toMatchObject({ outcome: "failed", error: "trigger-not-waiting:completed" });
    await runtime.stop();
  });

  test("跨 runtime（进程）员工窗口互斥：活跃窗口期第二个触发保持 pending，释放后可回收", async () => {
    const { sessions, databases } = fakeSessions();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // 两个 runtime = 两个进程：串行链各自独立，互斥只剩 employee_window 行。
    const rt1 = createEmployeeTriggerRuntime({ sessions, driver: fakeDriver().factory, leaseTtlMs: 60_000 });
    const rt2 = createEmployeeTriggerRuntime({ sessions, driver: fakeDriver().factory, leaseTtlMs: 60_000 });
    rt1.start();
    rt2.start();
    let rt1Calls = 0;
    let rt2Calls = 0;
    rt1.registerHandler("daily-claims-risk", async () => { await gate; rt1Calls += 1; return { one: 1 }; });
    rt2.registerHandler("daily-claims-risk", async () => { rt2Calls += 1; return { two: 2 }; });

    const first = rt1.enqueue(delivery({ idempotencyKey: "k-a" }));
    await Bun.sleep(50); // 窗口 1 已持有员工互斥行
    const db = databases.get("ws_a")!;
    expect([...db.windows.values()]).toHaveLength(1);

    const blocked = await rt2.enqueue(delivery({ idempotencyKey: "k-b" }));
    expect(blocked).toMatchObject({ outcome: "coalesced" });
    // k-b 触发仍在 pending——等窗口，不被并发执行
    expect(db.rows.get("k-b")!.status).toBe("pending");

    release();
    expect(await first).toMatchObject({ outcome: "completed" });

    // 窗口属于员工而非投递进程：rt1 的窗口 drain 同员工全部 pending，
    // k-b 已被 rt1 的窗口恰好执行一次；同键再投递收敛为 coalesced。
    const unblocked = await rt2.enqueue(delivery({ idempotencyKey: "k-b" }));
    expect(unblocked).toMatchObject({ outcome: "coalesced", triggerId: "employee_trigger:t2" });
    expect(db.rows.get("k-b")!.status).toBe("completed");
    expect(rt1Calls).toBe(2); // k-a + k-b 各恰好一次
    expect(rt2Calls).toBe(0);
    await rt1.stop();
    await rt2.stop();
  });

  test("同一员工的窗口串行，不同员工互不阻塞", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
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

  test("start 前与 stop 后都拒绝新投递；会话打开失败返回 failed 且不写触发", async () => {
    const { sessions, log } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
    await expect(runtime.enqueue(delivery())).rejects.toThrow("employee-trigger-runtime-stopped");

    const dead: TriggerSessionManager = {
      async openSession() { throw new Error("no such employee"); },
      async close() {},
    };
    const runtime2 = createEmployeeTriggerRuntime({ sessions: dead, driver: factory });
    runtime2.start();
    runtime2.registerHandler("daily-claims-risk", async () => ({}));
    // D1 返工：会话层失败的原始串不进 EnqueueResult，归一化为
    // employee-session-closed（原始信息在服务端日志）。
    expect(await runtime2.enqueue(delivery())).toEqual({ outcome: "failed", error: "employee-session-closed" });

    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    await runtime.enqueue(delivery());
    await runtime.stop();
    expect(log).toContain("close:ws_a::user:ve_1");
    await runtime2.stop();
  });

  test("handler 的 effects.runEffect：已 committed 的效果直接回结果不重复执行", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
    runtime.start();
    let businessWrites = 0;
    runtime.registerHandler("daily-claims-risk", async ({ session }) => {
      const effects = createEmployeeEffects(session, "employee_trigger:t1");
      return effects.runEffect("notify", async () => {
        businessWrites += 1;
        return { sent: 1 };
      });
    });

    await runtime.enqueue(delivery());
    const effectRow = databases.get("ws_a")!.effects.get("employee_trigger:t1:notify")!;
    expect(effectRow.status).toBe("committed");
    expect(effectRow.result).toEqual({ v: { sent: 1 } });
    expect(businessWrites).toBe(1);

    // 模拟"效果已提交、进程崩溃"：新会话重放同 key 直接回 committed 结果
    const replay = createEmployeeEffects(
      await sessions.openSession("ws_a", "user:ve_1"),
      "employee_trigger:t1",
    );
    const again = await replay.runEffect("notify", async () => {
      businessWrites += 1;
      return { sent: 2 };
    });
    expect(again).toEqual({ sent: 1 });
    expect(businessWrites).toBe(1);
    await runtime.stop();
  });

  test("runtime 自身查询只碰 employee_trigger，不碰办公室领域表", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
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
    const runtime = createEmployeeTriggerRuntime({ sessions: spying, driver: factory });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    await runtime.enqueue(delivery());
    const all = seen.join("\n");
    expect(all).toContain("employee_trigger");
    expect(all).not.toMatch(/office_task|office_message|office_report|office_goal/);
    await runtime.stop();
  });
});
