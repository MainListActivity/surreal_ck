import { describe, expect, test } from "bun:test";
import { createEmployeeEffects } from "./employee-effects";
import {
  createEmployeeTriggerRuntime,
  type EmployeeRunDriver,
  type EmployeeRunDriverFactory,
  type RuntimeSignal as _RS,
  type TriggerDelivery,
  type TriggerHandler,
  type TriggerSessionManager,
} from "./employee-trigger-runtime";
import type { RuntimeSignal } from "./employee-gates";

type Row = Record<string, unknown> & { id: string; status: string };

type FakeDb = {
  rows: Map<string, Row>;
  byId: Map<string, Row>;
  effects: Map<string, Row>;
  windows: Map<string, Row>;
  usage: Map<string, Row>;
  counter: number;
};

/** 内存版员工会话（与 employee-trigger-runtime.test.ts 同一语义模型 + usage 账本模拟）。 */
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
  const sessions: TriggerSessionManager & { openCalls: number } = {
    openCalls: 0,
    async openSession(database, employeeId) {
      sessions.openCalls += 1;
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
            const row: Row = { id: `employee_trigger:t${store.counter}`, created_at: store.counter, ...content } as Row;
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
  };
  return { sessions, log, databases, database: db };
}

type FakeDriver = EmployeeRunDriver & {
  calls: string[];
  states: Map<string, { status: string; result?: unknown } | null>;
};

function fakeDriver(): {
  factory: (ctx: Parameters<EmployeeRunDriverFactory>[0]) => FakeDriver;
  drivers: FakeDriver[];
} {
  const drivers: FakeDriver[] = [];
  const states = new Map<string, { status: string; result?: unknown } | null>();
  const factory = (ctx: Parameters<EmployeeRunDriverFactory>[0]): FakeDriver => {
    const runTrigger = async (
      trigger: Parameters<TriggerHandler>[0]["trigger"],
      resumeData?: unknown,
    ) => {
      const handler = ctx.resolveHandler(trigger.reason);
      if (!handler) return { status: "failed" as const, error: `no-handler:${trigger.reason}` };
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
        return { status: "success" as const, output };
      } catch (cause) {
        return {
          status: "failed" as const,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    };
    const driver: FakeDriver = {
      calls: [],
      states,
      async loadRunState(runId) {
        driver.calls.push(`load:${runId}`);
        return states.get(runId) ?? null;
      },
      async start({ runId, trigger }) {
        driver.calls.push(`start:${runId}`);
        return runTrigger(trigger);
      },
      async restart({ runId, trigger }) {
        driver.calls.push(`restart:${runId}`);
        return runTrigger(trigger);
      },
      async resume({ runId, trigger, resumeData }) {
        driver.calls.push(`resume:${runId}`);
        return runTrigger(trigger, resumeData);
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
  reason: "risk",
  payloadRef: "2026-09-30",
  chainDepth: 0,
  idempotencyKey: "risk:user:ve_1:2026-09-30",
  ...overrides,
});

function signalCollector() {
  const signals: RuntimeSignal[] = [];
  return { signals, emit: (signal: RuntimeSignal) => void signals.push(signal) };
}

const DAY = "2026-09-30";

describe("VER05 预算闸门（每员工每日 token 预算）", () => {
  test("preflight 按剩余额度压本次输出上限；provider usage 原子累计", async () => {
    const { sessions, databases, database } = fakeSessions();
    const { factory } = fakeDriver();
    // 当日已用 600：预算 1000 → 剩余 400；申报输入 100 → grant=min(2000, 8192, 300)=300
    const db = database("ws_a");
    db.usage.set("user:ve_1::" + DAY, {
      id: "employee_token_usage:u1",
      employee: "user:ve_1",
      day: DAY,
      status: "",
      provider_input_tokens: 400,
      provider_output_tokens: 200,
    } as Row);
    const { signals, emit } = signalCollector();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 1000, budgetTimezone: "Asia/Shanghai" },
      emitSignal: emit,
      now: () => new Date("2026-09-30T12:00:00+08:00"),
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    const grants: number[] = [];
    runtime.registerHandler("risk", async ({ model }) => {
      const text = await model.call(
        { maxOutputTokens: 2000, estimatedInputTokens: 100 },
        async (grant) => {
          grants.push(grant.maxOutputTokens);
          return { result: "ok", usage: { inputTokens: 120, outputTokens: 90 } };
        },
      );
      return { text };
    });

    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "completed" });
    // 剩余 = 1000-600 = 400；grant = min(2000, 8192, 400-100) = 300
    expect(grants).toEqual([300]);
    const usage = databases.get("ws_a")!.usage.get("user:ve_1::" + DAY)!;
    // 400+200 既有 + 实测 120+90 原子累计
    expect(usage.provider_input_tokens).toBe(520);
    expect(usage.provider_output_tokens).toBe(290);
    expect(usage.estimated_input_tokens ?? 0).toBe(0);
    expect(usage.calls).toBe(1);
    expect(signals).toHaveLength(0);
    await runtime.stop();
  });

  test("provider 未返回 usage 时用有界估算并记 estimated 列（计量来源可审计）", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 100_000 },
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("risk", async ({ model }) =>
      model.call({ maxOutputTokens: 1500, estimatedInputTokens: 300 }, async (grant) => ({
        result: { echoed: grant.maxOutputTokens },
        // usage 缺省 → 有界估算
      })),
    );
    await runtime.enqueue(delivery());
    const usage = databases.get("ws_a")!.usage.get([...databases.get("ws_a")!.usage.keys()][0]!)!;
    expect(usage.estimated_input_tokens).toBe(300);
    expect(usage.estimated_output_tokens).toBe(1500);
    expect(usage.provider_output_tokens ?? 0).toBe(0);
    await runtime.stop();
  });

  test("额度临界值：单次调用实际用量越过预算后，下一次调用不再发起 + 同日一次 signal", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const { signals, emit } = signalCollector();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 1000, fallbackInputTokens: 100 },
      emitSignal: emit,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    let invocations = 0;
    runtime.registerHandler("risk", async ({ model }) => {
      const out = await model.call({ maxOutputTokens: 400 }, async () => {
        invocations += 1;
        // provider 实测 900 in + 500 out = 1400 > budget 1000：一次性越过
        return { result: "done", usage: { inputTokens: 900, outputTokens: 500 } };
      });
      return { out };
    });
    const first = await runtime.enqueue(delivery());
    expect(first).toMatchObject({ outcome: "completed" });
    expect(invocations).toBe(1);
    const usage = databases.get("ws_a")!.usage.get("user:ve_1::" + DAY)!;
    expect(usage.provider_output_tokens).toBe(500);

    // 第二个触发（新幂等键）：preflight 已超额 → 不再发起调用，触发 failed
    const { factory: factory2 } = fakeDriver();
    const runtime2 = createEmployeeTriggerRuntime({
      sessions,
      driver: factory2,
      limits: { dailyTokenBudget: 1000, fallbackInputTokens: 100 },
      emitSignal: emit,
      sleep: () => Promise.resolve(),
    });
    runtime2.start();
    runtime2.registerHandler("risk", async ({ model }) => {
      const out = await model.call({ maxOutputTokens: 400 }, async () => {
        invocations += 1;
        return { result: "late" };
      });
      return { out };
    });
    const second = await runtime2.enqueue(delivery({ idempotencyKey: "risk:user:ve_1:next" }));
    expect(second).toMatchObject({ outcome: "failed" });
    expect(second.error).toContain("budget-exhausted");
    expect(invocations).toBe(1); // 超额员工不再发起模型调用
    const budgetSignals = signals.filter((s) => s.kind === "budget-exhausted");
    expect(budgetSignals).toHaveLength(1); // 同一天只产生一次 signal
    expect(budgetSignals[0]?.detail).toMatchObject({ day: DAY, budget: 1000 });

    // 同一进程内 handler 再次尝试调用也被闸（多心跳不重复发 signal）
    runtime2.registerHandler("risk", async ({ model }) => {
      try {
        await model.call({ maxOutputTokens: 10 }, async () => ({ result: "x" }));
      } catch { /* exhausted */ }
      try {
        await model.call({ maxOutputTokens: 10 }, async () => ({ result: "x" }));
      } catch { /* exhausted */ }
      return { survived: true };
    });
    await runtime2.enqueue(delivery({ idempotencyKey: "risk:user:ve_1:third" }));
    expect(signals.filter((s) => s.kind === "budget-exhausted")).toHaveLength(1);
    await runtime.stop();
    await runtime2.stop();
  });

  test("日期切换后新一天额度恢复，旧日用量行保留审计", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    let clock = new Date("2026-09-30T23:00:00+08:00");
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 500 },
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("risk", async ({ model }) =>
      model.call({ maxOutputTokens: 200, estimatedInputTokens: 250 }, async () => ({
        result: "ok",
        usage: { inputTokens: 250, outputTokens: 200 },
      })),
    );
    expect(await runtime.enqueue(delivery())).toMatchObject({ outcome: "completed" });
    // 当日 450 已用；再调一次也超额（250 估算输入 + 200 上限 > 剩余 50）
    const blocked = await runtime.enqueue(delivery({ idempotencyKey: "risk:late:same-day" }));
    expect(blocked).toMatchObject({ outcome: "failed" });
    expect(blocked.error).toContain("budget-exhausted");

    // 业务日翻页（Asia/Shanghai 2026-10-01）
    clock = new Date("2026-10-01T09:00:00+08:00");
    const nextDay = await runtime.enqueue(delivery({ idempotencyKey: "risk:next-day" }));
    expect(nextDay).toMatchObject({ outcome: "completed" });
    const keys = [...databases.get("ws_a")!.usage.keys()];
    expect(keys.sort()).toEqual(["user:ve_1::2026-09-30", "user:ve_1::2026-10-01"]);
    expect(databases.get("ws_a")!.usage.get("user:ve_1::2026-09-30")!.provider_output_tokens).toBe(200);
    await runtime.stop();
  });
});

describe("VER05 循环/步数与链深闸门", () => {
  test("窗口内模型调用步数超 maxStepsPerWindow → 明确终态 + step-limit signal", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const { signals, emit } = signalCollector();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxStepsPerWindow: 3, dailyTokenBudget: 1_000_000 },
      emitSignal: emit,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    let calls = 0;
    runtime.registerHandler("risk", async ({ model }) => {
      // handler 忘了自限：runtime 兜底闸门在第 4 次调用拒绝
      for (let i = 0; i < 10; i += 1) {
        await model.call({ maxOutputTokens: 1 }, async () => {
          calls += 1;
          return { result: i };
        });
      }
      return {};
    });
    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.error).toContain("step-limit-exceeded");
    expect(calls).toBe(3); // 第 4 次未发起
    expect(signals.some((s) => s.kind === "step-limit-exceeded")).toBe(true);
    await runtime.stop();
  });

  test("handler 读取 ctx.limits：限额交给 Mastra agent step / 循环条件使用", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxStepsPerWindow: 7, maxChainDepth: 5 },
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    let seen: { steps?: number; depth?: number } = {};
    runtime.registerHandler("risk", async ({ limits }) => {
      seen = { steps: limits.maxStepsPerWindow, depth: limits.maxChainDepth };
      return {};
    });
    await runtime.enqueue(delivery());
    expect(seen).toEqual({ steps: 7, depth: 5 });
    await runtime.stop();
  });

  test("级联触发链深继承 parent+1；外部投递超 max 直接拒绝 + signal", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const { signals, emit } = signalCollector();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxChainDepth: 2 },
      emitSignal: emit,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("risk", async ({ trigger, emit: cascade }) => {
      // 每次执行都试图级联一次：depth 0→1→2→3(拒绝)
      const r = await cascade({
        reason: "risk",
        idempotencyKey: `chain:${trigger.idempotencyKey}:next`,
      });
      return { cascade: r };
    });
    const first = await runtime.enqueue(delivery({ chainDepth: 0 }));
    expect(first).toMatchObject({ outcome: "completed" });

    // 让 drain/followup 把级联链跑完
    await Bun.sleep(30);
    const rows = [...databases.get("ws_a")!.byId.values()]
      .filter((row) => String(row.reason) === "risk")
      .sort((a, b) => Number(a.chain_depth) - Number(b.chain_depth));
    const depths = rows.map((row) => Number(row.chain_depth));
    // 链 0→1→2（depth 3 被拒绝不落库）
    expect(depths).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
    expect(signals.filter((s) => s.kind === "chain-depth-exceeded")).toHaveLength(1);

    // 外部投递超 max：拒绝 + signal，不落库
    const before = databases.get("ws_a")!.byId.size;
    const rejected = await runtime.enqueue(delivery({ chainDepth: 3, idempotencyKey: "ext:deep" }));
    expect(rejected).toMatchObject({ outcome: "failed" });
    expect(rejected.error).toContain("chain-depth-exceeded");
    expect(databases.get("ws_a")!.byId.size).toBe(before);
    expect(signals.filter((s) => s.kind === "chain-depth-exceeded")).toHaveLength(2);
    await runtime.stop();
  });

  test("级联投递不接受调用方给的链深（emit 入参无 chainDepth）", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxChainDepth: 4 },
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("risk", async ({ emit: cascade, trigger }) => {
      const r = await cascade({ reason: "risk", idempotencyKey: `child:${trigger.id}` });
      return { childDepth: r.accepted ? r.chainDepth : -1 };
    });
    // 父触发本身 chainDepth=3：子 = 4（允许），孙 = 5（超 max 拒绝）
    await runtime.enqueue(delivery({ chainDepth: 3, idempotencyKey: "parent:deep" }));
    await Bun.sleep(30);
    const child = databases.get("ws_a")!.rows.get("child:employee_trigger:t1");
    expect(child?.chain_depth).toBe(4); // 强制 parent+1，不可能传更小值
    await runtime.stop();
  });
});

describe("VER05 有界重试", () => {
  test("transient provider 故障按上限退避重试；permanent 错误不重试", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const sleeps: number[] = [];
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 1_000_000 },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    runtime.start();
    let transientFails = 0;
    let permanentCalls = 0;
    runtime.registerHandler("risk", async ({ model }) => {
      const ok = await model.call({ maxOutputTokens: 10 }, async () => {
        transientFails += 1;
        if (transientFails < 3) {
          const err = new Error("rate limit exceeded");
          (err as { statusCode?: number }).statusCode = 429;
          throw err;
        }
        return { result: "recovered", usage: { inputTokens: 1, outputTokens: 1 } };
      });
      let permanentThrown = false;
      try {
        await model.call({ maxOutputTokens: 10 }, async () => {
          permanentCalls += 1;
          throw new Error("permission denied on table foo");
        });
      } catch (cause) {
        permanentThrown = cause instanceof Error && /permission/i.test(cause.message);
      }
      return { ok, permanentThrown };
    });
    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "completed" });
    expect(transientFails).toBe(3); // 两次退避后第 3 次成功
    expect(permanentCalls).toBe(1); // permission 不重试
    expect(sleeps.length).toBe(2); // 只在两次 transient 间退避
    await runtime.stop();
  });

  test("transient 故障超过 maxAttempts 如实失败（有界）", async () => {
    const { sessions } = fakeSessions();
    const { factory } = fakeDriver();
    const sleeps: number[] = [];
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { dailyTokenBudget: 1_000_000 },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 100, jitterRatio: 0 },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    runtime.start();
    let calls = 0;
    runtime.registerHandler("risk", async ({ model }) =>
      model.call({ maxOutputTokens: 10 }, async () => {
        calls += 1;
        throw new Error("socket hang up");
      }),
    );
    const result = await runtime.enqueue(delivery());
    expect(result).toMatchObject({ outcome: "failed" });
    expect(calls).toBe(3); // 1 + 2 retries
    expect(sleeps).toEqual([50, 100]); // 指数退避封顶 maxDelayMs（jitter=0）
    await runtime.stop();
  });

  test("认领次数超 maxTriggerAttempts → failed 终态 + retry-exhausted signal", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const { signals, emit } = signalCollector();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxTriggerAttempts: 2 },
      emitSignal: emit,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("risk", async () => ({ ok: true }));
    // 直接种一个 attempts=2 的 pending 行（已跑过上限仍回 pending 的异常态）
    const db = databases.get("ws_a") ?? { rows: new Map(), byId: new Map(), effects: new Map(), windows: new Map(), usage: new Map(), counter: 0 };
    databases.set("ws_a", db);
    void databases;
    db.counter = 1;
    const row: Row = {
      id: "employee_trigger:t1",
      employee: "user:ve_1",
      reason: "risk",
      idempotency_key: "k-stuck",
      chain_depth: 0,
      status: "pending",
      attempts: 2,
      created_at: 1,
    } as Row;
    db.byId.set(row.id, row);
    db.rows.set("k-stuck", row);
    const summary = await runtime.reconcile({ database: "ws_a", employeeId: "user:ve_1" });
    expect(summary.failed).toBe(1);
    expect(row.status).toBe("failed");
    expect(row.error_message).toContain("attempts-exhausted");
    expect(signals.some((s) => s.kind === "retry-exhausted")).toBe(true);
    await runtime.stop();
  });
});

describe("VER05 事件风暴与全局背压", () => {
  test("同员工 50 条突发事件：恰好一次执行，窗口数 ≤2（当前 + 至多一个后续）", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: factory });
    runtime.start();
    const seen = new Set<string>();
    runtime.registerHandler("risk", async ({ trigger }) => {
      if (seen.has(trigger.idempotencyKey)) throw new Error("duplicate execution");
      seen.add(trigger.idempotencyKey);
      await Bun.sleep(2);
      return { done: trigger.idempotencyKey };
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runtime.enqueue(delivery({ idempotencyKey: `storm:${i}` })),
      ),
    );
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
    expect(seen.size).toBe(50);
    // 窗口属于员工：≤ 当前 + 一个合并后续窗口（以 employee_window 争夺次数计）
    const windowRow = databases.get("ws_a")!.windows.get("user:ve_1")!;
    expect(windowRow).toBeDefined();
    // 会话打开次数 << 50（drain 复用同一会话，旧模型每窗一开一关）
    expect(sessions.openCalls).toBeLessThanOrEqual(3);
    await runtime.stop();
  });

  test("多员工并发：全局同时运行窗口数不超过 maxConcurrentWindows", async () => {
    const { sessions, databases } = fakeSessions();
    const { factory } = fakeDriver();
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: factory,
      limits: { maxConcurrentWindows: 3 },
    });
    runtime.start();
    let active = 0;
    let maxActive = 0;
    runtime.registerHandler("risk", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(5);
      active -= 1;
      return {};
    });
    // 12 个不同员工各 1 条触发
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runtime.enqueue(delivery({
          employeeId: `user:ve_${i}`,
          idempotencyKey: `conc:${i}`,
        })),
      ),
    );
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThanOrEqual(2); // 确实有并发
    await runtime.stop();
  });
});
