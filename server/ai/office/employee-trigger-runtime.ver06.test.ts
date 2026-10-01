import { describe, expect, test } from "bun:test";
import { createEmployeeEffects } from "./employee-effects";
import {
  createEmployeeTriggerRuntime,
  type EmployeeRunDriver,
  type EmployeeRunDriverFactory,
  type EmployeeRunResult,
  type TriggerDelivery,
  type TriggerHandler,
  type TriggerSessionManager,
} from "./employee-trigger-runtime";
import { createEmployeeRuntimeSupervisor } from "./employee-supervisor";

type Row = Record<string, unknown> & { id: string; status: string };

type FakeDb = {
  rows: Map<string, Row>;
  byId: Map<string, Row>;
  effects: Map<string, Row>;
  windows: Map<string, Row>;
  usage: Map<string, Row>;
  counter: number;
  /** 按 SQL 片段定向注入故障：match 命中的接下来 left 次 query 抛连接错。 */
  failures: Array<{ match: string; left: number }>;
};

/** 同 VER04/05 的内存会话替身，追加 lease 清回与故障注入分支。 */
function fakeSessions() {
  const log: string[] = [];
  const databases = new Map<string, FakeDb>();
  const db = (name: string): FakeDb => {
    let entry = databases.get(name);
    if (!entry) {
      entry = {
        rows: new Map(), byId: new Map(), effects: new Map(),
        windows: new Map(), usage: new Map(), counter: 0, failures: [],
      };
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
          const hit = store.failures.find((f) => f.left > 0 && sql.includes(f.match));
          if (hit) {
            hit.left -= 1;
            throw new Error("connection reset by peer");
          }
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
          // abort 路径的 lease 清回：status 保持 leased/running，lease_expires_at 置空。
          if (sql.includes("UPDATE $trigger") && sql.includes("lease_expires_at = NONE")) {
            const row = store.byId.get(String(params.trigger));
            if (row && ["leased", "running"].includes(row.status)) {
              row.lease_expires_at = undefined;
            }
            return [[]];
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
            if (sql.includes("LIMIT 1")) return [matched.slice(0, 1)];
            return [matched];
          }
          if (sql.includes("FROM $trigger")) {
            const row = store.byId.get(String(params.trigger));
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
    // 与生产 EmployeeRuntime.sessionStats() 同契约：替身暴露活计数，
    // 防止 metrics().connections 因接口名错位静默归零。
    sessionStats() {
      const opens = log.filter((entry) => entry.startsWith("open:")).length;
      const closes = log.filter((entry) => entry.startsWith("close:")).length;
      return {
        activeSessions: opens - closes,
        connects: opens,
        reconnects: 0,
        disconnects: 0,
        renewals: 0,
        renewalFailures: 0,
        invalidated: 0,
      };
    },
  };
  return { sessions, log, databases, db };
}

/** 默认按真实 handler 执行的 fake driver；script 覆盖可注入挂起/失败。 */
function fakeDriver(script: Map<string, EmployeeRunResult | "hang"> = new Map()) {
  const drivers: Array<EmployeeRunDriver & { calls: string[]; aborts: number }> = [];
  const states = new Map<string, { status: string; result?: unknown } | null>();
  const factory: EmployeeRunDriverFactory = (ctx) => {
    const runTrigger = async (
      trigger: Parameters<TriggerHandler>[0]["trigger"],
      resumeData?: unknown,
    ): Promise<EmployeeRunResult> => {
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
    const driver: EmployeeRunDriver & { calls: string[]; aborts: number } = {
      calls: [],
      aborts: 0,
      async loadRunState(runId) {
        driver.calls.push(`load:${runId}`);
        return states.get(runId) ?? null;
      },
      async start({ runId, trigger }) {
        driver.calls.push(`start:${runId}`);
        const override = script.get(`start:${runId}`);
        if (override === "hang") return new Promise<never>(() => {});
        return override ?? runTrigger(trigger);
      },
      async restart({ runId, trigger }) {
        driver.calls.push(`restart:${runId}`);
        const override = script.get(`restart:${runId}`);
        if (override === "hang") return new Promise<never>(() => {});
        return override ?? runTrigger(trigger);
      },
      async resume({ runId, trigger, resumeData }) {
        driver.calls.push(`resume:${runId}`);
        const override = script.get(`resume:${runId}`);
        if (override === "hang") return new Promise<never>(() => {});
        return override ?? runTrigger(trigger, resumeData);
      },
      abort() {
        driver.aborts += 1;
        driver.calls.push("abort");
      },
    };
    drivers.push(driver);
    return driver;
  };
  return { factory, drivers, states };
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await Bun.sleep(0);
};

/** 确定性虚拟时钟：now/sleep/schedule 全部走同一 epoch，advance 推进并触发到期项。 */
function fakeClock(startIso = "2026-09-30T15:00:00Z") {
  let epoch = Date.parse(startIso);
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: () => new Date(epoch),
    iso: () => new Date(epoch).toISOString(),
    epoch: () => epoch,
    schedule: (fn: () => void, ms: number) => {
      id += 1;
      timers.set(id, { at: epoch + ms, fn });
      return id;
    },
    cancel: (handle: unknown) => {
      timers.delete(handle as number);
    },
    sleep: (ms: number) => new Promise<void>((resolve) => {
      clock.schedule(resolve, ms);
    }),
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
        await flush();
      }
      epoch = target;
      await flush();
    },
  };
  return clock;
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

describe("VER06 关停：限时排空 → abort → 释放 lease", () => {
  test("stop 到点 abort 挂起的 run：driver.abort 下发、lease 释放、可立即回收", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory, drivers } = fakeDriver(
      new Map([["start:er-employee_trigger:t1", "hang"]]),
    );
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    const enqueued = runtime.enqueue(delivery());
    await flush(30);
    expect(drivers[0]?.calls).toContain("start:er-employee_trigger:t1");

    const stopping = runtime.stop({ deadlineMs: 100 });
    await clock.advance(120);
    await stopping;

    // driver.abort 已下发；触发 lease 清回可回收态；窗口互斥行已释放。
    expect(drivers[0]?.calls).toContain("abort");
    const row = databases.get("ws_a")!.byId.get("employee_trigger:t1")!;
    expect(["leased", "running"]).toContain(row.status);
    expect(row.lease_expires_at).toBeUndefined();
    const window = databases.get("ws_a")!.windows.get("user:ve_1")!;
    expect(window.holder).toBeUndefined();
    expect(window.lease_expires_at).toBeUndefined();

    const outcome = await enqueued;
    expect(outcome.outcome).toBe("failed");

    const metrics = runtime.metrics();
    expect(metrics.shutdown.timedOut).toBe(true);
    expect(metrics.shutdown.abortedWindows).toBe(1);
    expect(metrics.windows.aborted).toBe(1);

    // 新 runtime（模拟重启进程）reconcile 即可立即回收——无需等 lease TTL。
    const { factory: factory2, drivers: drivers2 } = fakeDriver();
    const runtime2 = createEmployeeTriggerRuntime({
      sessions,
      driver: factory2,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime2.start();
    runtime2.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    const summary = await runtime2.reconcile({ database: "ws_a", employeeId: "user:ve_1" });
    expect(summary.reclaimed).toBe(1);
    expect(row.status).toBe("completed");
    expect(drivers2[0]?.calls.some((c) => c.includes("employee_trigger:t1"))).toBe(true);
    await runtime2.stop();
  });

  test("stop 先停收后排空：deadline 内完成的窗口不超时；enqueue 立即拒绝", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime.start();
    let releaseHandler: () => void = () => undefined;
    runtime.registerHandler("daily-claims-risk", async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return { ok: true };
    });

    const enqueued = runtime.enqueue(delivery());
    await flush(30);
    const stopping = runtime.stop({ deadlineMs: 500 });
    // 停收立即生效
    await expect(runtime.enqueue(delivery({ idempotencyKey: "k2" })))
      .rejects.toThrow("employee-trigger-runtime-stopped");
    await expect(enqueued).resolves.toMatchObject({ outcome: "failed" });
    // 在途 run 仍可正常完成 → deadline 内排空 → 不超时
    releaseHandler();
    await flush(30);
    await stopping;
    const metrics = runtime.metrics();
    expect(metrics.shutdown.timedOut).toBe(false);
    expect(metrics.shutdown.abortedWindows).toBe(0);
    expect(metrics.shutdown.durationMs).not.toBeNull();
  });

  test("stop 幂等：重复调用共享同一次关停", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory, sleep: () => Promise.resolve() });
    runtime.start();
    const a = runtime.stop({ deadlineMs: 10 });
    const b = runtime.stop({ deadlineMs: 10 });
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(runtime.metrics().shutdown.runs).toBe(1);
  });
});

describe("VER06 断线恢复：持久化队列是事实来源", () => {
  test("窗口期会话查询断线 → 行保留 lease；恢复后 reconcile 完成", async () => {
    const { sessions, databases, db } = fakeSessions();
    const { factory } = fakeDriver();
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
      leaseTtlMs: 60_000,
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));

    // 投递落库成功，但窗口驱动触发时连接断开：认领后 setStatus("running")
    // 的 UPDATE 抛连接错（定向注入，不影响之前的 INSERT/认领）。
    db("ws_a").failures.push({ match: "SET status = $status", left: 1 });
    const enqueued = runtime.enqueue(delivery());
    await flush(40);
    // 窗口崩溃：触发保持 leased + lease 未到期；waiter 如实失败。
    await expect(enqueued).resolves.toMatchObject({ outcome: "failed" });
    const row = databases.get("ws_a")!.byId.get("employee_trigger:t1")!;
    expect(row.status).toBe("leased");
    expect(row.lease_expires_at).toBeInstanceOf(Date);

    // lease 到期后 reconcile 回收并执行完成——不依赖任何 LIVE/内存通知。
    await clock.advance(61_000);
    const summary = await runtime.reconcile({ database: "ws_a", employeeId: "user:ve_1" });
    expect(summary).toMatchObject({ scanned: 1, reclaimed: 1, completed: 1 });
    expect(row.status).toBe("completed");
    const metrics = runtime.metrics();
    expect(metrics.reconcile.runs).toBe(1);
    expect(metrics.windows.crashed).toBeGreaterThanOrEqual(1);
    await runtime.stop();
  });

  test("会话打开 transient 故障 → 有界重试成功 → 触发完成，retries 计数落账", async () => {
    const base = fakeSessions();
    let failuresLeft = 2;
    const sessions: TriggerSessionManager = {
      async openSession(database, employeeId) {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("connection reset by peer");
        }
        return base.sessions.openSession(database, employeeId);
      },
      close: (d, e) => base.sessions.close(d, e),
    };
    const { factory } = fakeDriver();
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 200, jitterRatio: 0 },
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    const enqueued = runtime.enqueue(delivery());
    await flush(10); // 第 1 次 openSession 失败并注册首个退避定时器
    await clock.advance(400); // 两次退避（100ms + 200ms）到期
    await flush(10); // 第 3 次成功 → 投递 → 窗口跑完
    await expect(enqueued).resolves.toMatchObject({ outcome: "completed" });
    const metrics = runtime.metrics();
    expect(metrics.sessions.openRetries).toBe(2);
    expect(metrics.retries).toBe(2);
    await runtime.stop();
  });
});

describe("VER06 观测指标", () => {
  test("metrics 覆盖 session/trigger/retry/token/lease/reconnect/shutdown，且无 secret", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async ({ model }) => {
      await model.call({ maxOutputTokens: 100, estimatedInputTokens: 40 }, async () => ({
        result: "ok",
        usage: { inputTokens: 12, outputTokens: 7 },
      }));
      return { ok: true };
    });
    await runtime.enqueue(delivery());
    await runtime.enqueue(delivery()); // coalesced
    await runtime.stop();

    const m = runtime.metrics();
    expect(m.triggers.enqueued).toBe(2);
    expect(m.triggers.coalesced).toBe(1);
    expect(m.triggers.completed).toBe(1);
    expect(m.triggers.running).toBe(0);
    expect(m.tokenUsage).toEqual({
      providerInputTokens: 12,
      providerOutputTokens: 7,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      calls: 1,
    });
    expect(m.windows.completed).toBe(1);
    expect(m.lease.activeWindows).toBe(0);
    expect(m.shutdown.runs).toBe(1);
    // 接线级断言：会话源的 sessionStats() 必须透传到 metrics().connections
    //（曾以 stats/sessionStats 命名错位导致生产恒零）。
    expect(m.connections.connects).toBeGreaterThanOrEqual(1);
    expect(m.sessions.open).toBe(m.connections.activeSessions);
    // 指标快照序列化后不含 secret/token 字段内容
    const json = JSON.stringify(m);
    expect(json).not.toContain("s3cret");
    expect(json.toLowerCase()).not.toContain("token\":\""); // tokenUsage 是数字键名
  });

  test("运行窗口的 lease age 可观测", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const clock = fakeClock();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime.start();
    let releaseHandler: () => void = () => undefined;
    runtime.registerHandler("daily-claims-risk", async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return { ok: true };
    });
    const enqueued = runtime.enqueue(delivery());
    await flush(30);
    await clock.advance(30_000);
    const m = runtime.metrics();
    expect(m.lease.activeWindows).toBe(1);
    expect(m.lease.oldestWindowAgeMs).toBeGreaterThanOrEqual(30_000);
    expect(m.windows.running).toBe(1);
    expect(m.triggers.running).toBe(1);
    releaseHandler();
    await enqueued.catch(() => undefined);
    await runtime.stop();
  });
});

describe("VER06 24h 虚拟时钟长跑", () => {
  test("24h+ 运行：多触发跨预算日换日记账，uptime/计数一致", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const clock = fakeClock("2026-09-30T15:00:00Z"); // 上海时区 23:00
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      now: clock.now,
      sleep: clock.sleep,
    });
    runtime.start();
    let calls = 0;
    runtime.registerHandler("daily-claims-risk", async ({ model }) => {
      calls += 1;
      await model.call({ maxOutputTokens: 100, estimatedInputTokens: 40 }, async () => ({
        result: "ok",
        usage: { inputTokens: 10, outputTokens: 5 },
      }));
      return { ok: true };
    });

    // 0h、2h（跨上海零点→10-01）、26h（10-02）各投一条触发。
    for (const [hour, key] of [[0, "k0"], [2, "k2"], [26, "k26"]] as const) {
      await clock.advance(hour === 0 ? 0 : hour * 3_600_000 - (hour === 26 ? 2 * 3_600_000 : 0));
      await runtime.enqueue(delivery({ idempotencyKey: key }));
    }
    const usage = databases.get("ws_a")!.usage;
    // 三个业务日各一行：2026-09-30、2026-10-01、2026-10-02（Asia/Shanghai）
    const days = [...usage.values()].map((row) => String(row.day)).sort();
    expect(days).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(calls).toBe(3);
    const m = runtime.metrics();
    expect(m.tokenUsage.calls).toBe(3);
    expect(m.tokenUsage.providerInputTokens).toBe(30);
    expect(m.uptimeMs).toBeGreaterThanOrEqual(26 * 3_600_000);
    await runtime.stop();
  });
});

describe("VER06 启动监督：分批 reconcile", () => {
  test("有界并发枚举 workspace×员工：进度、inFlight 上限、单员工失败不中断", async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let maxInFlight = 0;
    const reconciled: string[] = [];
    const runtime = {
      async reconcile({ database, employeeId }: { database: string; employeeId: string }) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1); // 真实极短延迟让并发可见
        });
        inFlight -= 1;
        if (employeeId === "user:bad") throw new Error("boom");
        reconciled.push(`${database}::${employeeId}`);
        return { scanned: 1, reclaimed: 0, completed: 0, waiting: 0, failed: 0 };
      },
    };
    const supervisor = createEmployeeRuntimeSupervisor({
      runtime,
      sessions: { warmup: async () => ({ databases: 3, credentials: 9 }) },
      listWorkspaces: async () => ["ws_a", "ws_b"],
      listActiveEmployees: async (db) =>
        db === "ws_a" ? ["user:ve_1", "user:bad", "user:ve_3"] : ["user:ve_4"],
      concurrency: 2,
      now: clock.now,
    });
    const progress = await supervisor.start();
    expect(progress.state).toBe("done");
    expect(progress.workspacesTotal).toBe(2);
    expect(progress.employeesTotal).toBe(4);
    expect(progress.employeesReconciled).toBe(3);
    expect(progress.employeesFailed).toBe(1);
    expect(progress.warmup).toEqual({ databases: 3, credentials: 9 });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(reconciled).toContain("ws_b::user:ve_4");
    expect(progress.lastError).toContain("boom");
  });

  test("start 幂等：并发调用共享同一次启动；枚举失败进入 failed 态", async () => {
    const supervisor = createEmployeeRuntimeSupervisor({
      runtime: { reconcile: async () => ({ scanned: 0, reclaimed: 0, completed: 0, waiting: 0, failed: 0 }) },
      listWorkspaces: async () => {
        throw new Error("system unreachable");
      },
      listActiveEmployees: async () => [],
    });
    const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
    expect(a.state).toBe("failed");
    expect(a.lastError).toContain("system unreachable");
    expect(supervisor.progress().state).toBe("failed");
    expect(a).toEqual(b);
  });
});

describe("VER06 容量：单实例背压上限与实测记录", () => {
  test("全局并发窗口硬上限：4 槽 × 16 员工 × 3 触发全收敛；连接=lane 数", async () => {
    const { sessions, log } = fakeSessions();
    let inFlight = 0;
    let peakInFlight = 0;
    const rssBefore = process.memoryUsage().rss;
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: fakeDriver().factory,
      limits: { maxConcurrentWindows: 4 },
    });
    runtime.registerHandler("daily-claims-risk", async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ok: true };
      } finally {
        inFlight -= 1;
      }
    });
    runtime.start();

    const employees = Array.from({ length: 16 }, (_, i) => `user:ve_${i}`);
    const enqueues: Array<Promise<unknown>> = [];
    const t0 = performance.now();
    for (const employeeId of employees) {
      for (let k = 0; k < 3; k += 1) {
        enqueues.push(runtime.enqueue(delivery({
          employeeId,
          idempotencyKey: `cap:${employeeId}:${k}`,
          payloadRef: `cap:${k}`,
        })));
      }
    }
    const results = await Promise.all(enqueues);
    const elapsedMs = performance.now() - t0;
    const rssAfter = process.memoryUsage().rss;

    expect(results.every((r) => (r as { outcome?: string }).outcome === "completed")).toBe(true);
    expect(peakInFlight).toBeLessThanOrEqual(4);
    expect(peakInFlight).toBeGreaterThan(1); // 并发确实发生过，上限不是被串行化掩盖
    const connections = log.filter((l) => l.startsWith("open:")).length;
    expect(connections).toBeLessThanOrEqual(16); // 每 lane 最多一条会话

    const metrics = runtime.metrics();
    expect(metrics.triggers.completed).toBe(48);
    expect(metrics.windows.completed).toBeGreaterThan(0);

    // 实测记录（issue 容量验收的原始数据——打印到测试输出，不进指标）。
    const throughput = Math.round(48 / (elapsedMs / 1000));
    console.info(
      `[capacity] connections=${connections} triggers=48 elapsed=${Math.round(elapsedMs)}ms ` +
      `throughput=${throughput}tps peakInFlight=${peakInFlight} ` +
      `rssDelta=${Math.round((rssAfter - rssBefore) / 1024 / 1024)}MB`,
    );
    expect(Math.round((rssAfter - rssBefore) / 1024 / 1024)).toBeLessThan(256);

    await runtime.stop();
    const m = runtime.metrics();
    expect(m.shutdown.timedOut).toBe(false);
  });
});
