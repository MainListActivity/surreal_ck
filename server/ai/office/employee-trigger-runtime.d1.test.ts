import { describe, expect, test } from "bun:test";
import { createEmployeeEffects } from "./employee-effects";
import {
  createEmployeeTriggerRuntime,
  type EmployeeRunDriverFactory,
  type EmployeeTriggerRuntime,
  type TriggerDelivery,
  type TriggerHandler,
  type TriggerSessionManager,
} from "./employee-trigger-runtime";

/**
 * VER 联验返工 D1（任务 303608de）：pause/retire 的会话关闭落在执行窗口内时，
 * lane 曾因「悬挂窗口 + 死会话复用」卡死到进程重启。本文件用确定性 fake
 * 复现该竞态并验证修复合同：
 * 1. 竞态收敛——失效通知/看门狗让窗口有界结束，windowPlanned/waiters 复位；
 * 2. 死会话不复用——resume 后新代次全新会话、投递恢复 completed；
 * 3. waiter 有界结算——归一化错误码（employee-session-closed / window-lease-expired）；
 * 4. 回收链路——清回 lease 的 running 触发在下次投递窗口被认领并收敛到终态；
 * 5. 原回归——pause 中投递快速 failed 不落库、retire 拒绝。
 */

type Row = Record<string, unknown> & { id: string; status: string };

/**
 * 可编排故障的 fake 会话管理器（查询语义与 employee-trigger-runtime.test.ts
 * 的内存版一致）：
 * - close(..., options) 带生命周期 options 时同步触发 onSessionClosed
 *   （对应生产 EmployeeRuntime → invalidateSession 的装配）；
 * - blockOpen 模拟 pause/retire 后的员工（SIGNIN 拒绝）；
 * - openCount 供「新代次全新会话」断言。
 */
function fakeSessions(input: {
  onSessionClosed?: (database: string, employeeId: string) => void;
} = {}) {
  const rows = new Map<string, Row>(); // idempotency_key → trigger row
  const byId = new Map<string, Row>();
  const effects = new Map<string, Row>();
  const windows = new Map<string, Row>();
  let counter = 0;
  let effectCounter = 0;
  let openSessionFail: Error | null = null;
  let openCount = 0;
  let hangPattern: RegExp | null = null;
  let hangNotify: (() => void) | null = null;

  const sessions: TriggerSessionManager = {
    async openSession(_database, _employeeId) {
      if (openSessionFail) throw openSessionFail;
      openCount += 1;
      return {
        async query(sql: string, params: Record<string, unknown> = {}) {
          // D1 二次返工：确定性悬挂钩子——命中 pattern 的查询永不 settle
          //（模拟 SDK 对被关闭/僵尸连接的 query 行为）。
          if (hangPattern && hangPattern.test(sql)) {
            hangNotify?.();
            await new Promise<never>(() => undefined);
          }
          if (sql.includes("INSERT INTO employee_trigger")) {
            const content = params.content as Record<string, unknown>;
            const key = String(content.idempotency_key);
            const existing = rows.get(key);
            if (existing) return [[existing]];
            counter += 1;
            const row: Row = {
              id: `employee_trigger:t${counter}`,
              created_at: counter,
              ...content,
            } as Row;
            rows.set(key, row);
            byId.set(row.id, row);
            return [[row]];
          }
          if (sql.includes("INSERT INTO employee_effect")) {
            const content = params.content as Record<string, unknown>;
            const key = String(content.effect_key);
            const existing = effects.get(key);
            if (existing) return [[existing]];
            effectCounter += 1;
            const row: Row = { id: `employee_effect:e${effectCounter}`, ...content } as Row;
            effects.set(key, row);
            return [[row]];
          }
          if (sql.includes("UPDATE employee_effect")) {
            const row = effects.get(String(params.effectKey));
            if (row) {
              row.status = "committed";
              row.result = params.result;
            }
            return [[]];
          }
          if (sql.includes("UPSERT employee_window")) {
            const employee = String(params.employee);
            const existing = windows.get(employee);
            const nowTs = params.now as Date;
            const held = existing
              && existing.lease_expires_at instanceof Date
              && existing.lease_expires_at > nowTs;
            if (existing && held) return [[]];
            if (existing) {
              existing.lease_expires_at = params.leaseExpires;
              existing.holder = params.holder;
              return [[existing]];
            }
            const row: Row = {
              id: `employee_window:w${windows.size + 1}`,
              employee: params.employee,
              holder: params.holder,
              lease_expires_at: params.leaseExpires,
            } as Row;
            windows.set(employee, row);
            return [[row]];
          }
          if (sql.includes("UPDATE employee_window")) {
            const row = windows.get(String(params.employee));
            if (row && row.holder === params.holder && sql.includes("holder = NONE")) {
              row.lease_expires_at = undefined;
              row.holder = undefined;
            }
            return [[]];
          }
          if (sql.includes("UPDATE $trigger") && "claimable" in params) {
            const row = byId.get(String(params.trigger));
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
          if (sql.includes("UPDATE $trigger") && sql.includes("SET lease_expires_at = NONE")) {
            // clearTriggerLease：只清 lease，status 不动（清回可回收态）。
            // 注意 SET 子句（而非 WHERE）才是它的形态——claimLease 的 WHERE
            // 里同样出现 lease_expires_at = NONE，不能作为判据。
            const row = byId.get(String(params.trigger));
            if (row && ["leased", "running"].includes(row.status)) {
              row.lease_expires_at = undefined;
            }
            return [[]];
          }
          if (sql.includes("UPDATE $trigger")) {
            const row = byId.get(String(params.trigger));
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
            const matched = [...byId.values()]
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
            const row = byId.get(String(params.trigger));
            if (row && "employee" in params && String(row.employee) !== String(params.employee)) {
              return [[]];
            }
            return [row ? [row] : []];
          }
          return [[]];
        },
      };
    },
    async close(database, employeeId, options) {
      if (options) input.onSessionClosed?.(database, employeeId);
    },
  };
  return {
    sessions,
    openCount: () => openCount,
    /** 模拟 pause/retire 后的员工：openSession（SIGNIN）直接拒绝。 */
    blockOpen(fail: Error | null) {
      openSessionFail = fail;
    },
    /** D1 二次返工：命中 pattern 的查询永不 settle（僵尸连接语义）；null 解除。
     *  onHang 在悬挂真正发生时回调（供测试确定性地把 close 打进在途窗口）。 */
    hangMatching(pattern: RegExp | null, onHang?: () => void) {
      hangPattern = pattern;
      hangNotify = onHang ?? null;
    },
    allRows(): Row[] {
      return [...byId.values()];
    },
  };
}

/** fake driver：handler 通过 resolveHandler 执行（与生产一致的 effects ctx）。 */
function fakeDriver(handlers: Map<string, TriggerHandler>): {
  factory: EmployeeRunDriverFactory;
} {
  let gates: Parameters<EmployeeRunDriverFactory>[0]["gates"] | null = null;
  let sessionRef: Parameters<EmployeeRunDriverFactory>[0]["session"] | null = null;
  const runTrigger = async (trigger: { reason: string; id: string }) => {
    const handler = handlers.get(trigger.reason);
    if (!handler) return { status: "failed" as const, error: `no-handler:${trigger.reason}` };
    try {
      const output = await handler({
        trigger: trigger as Parameters<TriggerHandler>[0]["trigger"],
        session: sessionRef!,
        effects: createEmployeeEffects(sessionRef!, trigger.id),
        suspend: async () => {
          throw new Error("suspend not supported");
        },
        ...gates!.forTrigger(trigger as Parameters<TriggerHandler>[0]["trigger"]),
      });
      return { status: "success" as const, output };
    } catch (cause) {
      return { status: "failed" as const, error: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  const factory: EmployeeRunDriverFactory = (ctx) => {
    gates = ctx.gates;
    sessionRef = ctx.session;
    return {
      async loadRunState() {
        return null;
      },
      async start({ trigger }) {
        return runTrigger(trigger);
      },
      async restart({ trigger }) {
        return runTrigger(trigger);
      },
      async resume({ trigger }) {
        return runTrigger(trigger);
      },
    };
  };
  return { factory };
}

const delivery = (overrides: Partial<TriggerDelivery> = {}): TriggerDelivery => ({
  database: "ws_a",
  employeeId: "user:ve_1",
  reason: "qa-probe",
  chainDepth: 0,
  idempotencyKey: "qa-probe:ve_1:1",
  ...overrides,
});

/** 有界断言：promise 必须在 timeoutMs 内结算，否则测试失败（模拟 CF 524 前的判定）。 */
function bounded<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`未在有界时间内收敛（>${timeoutMs}ms）——D1 悬挂复现`)), timeoutMs),
    ),
  ]);
}

describe("D1 竞态收敛：pause 关闭落在执行窗口内", () => {
  test("失效通知中止在途窗口：投递有界 failed(employee-session-closed)，触发清回可回收，resume 后投递恢复 completed", async () => {
    const handlers = new Map<string, TriggerHandler>();
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions({
      onSessionClosed: (database, employeeId) =>
        runtime.invalidateSession({ database, employeeId }),
    });
    const runtime: EmployeeTriggerRuntime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      windowDeadlineMs: 5_000,
    });
    runtime.start();

    let calls = 0;
    const entered = new Promise<void>((resolve) => {
      handlers.set("qa-probe", async () => {
        calls += 1;
        if (calls === 1) {
          resolve();
          await new Promise<never>(() => undefined); // 首次执行悬挂（D1 死会话语义）
        }
        return { probe: true, call: calls };
      });
    });

    const first = runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:d1" }));
    await bounded(entered, 2_000); // 窗口在途（handler 已进入）
    expect(hooked.openCount()).toBe(1);

    // pause：生命周期关闭会话，失效通知落在窗口内。
    await hooked.sessions.close("ws_a", "user:ve_1", { deactivate: true });

    // 投递请求必须有界收敛（D1 原象：悬挂至 CF 524）。
    await bounded(expect(first).resolves.toMatchObject({
      outcome: "failed",
      error: "employee-session-closed",
    }));
    // 触发行清回可回收态：running/leased 且 lease 缺失（reconcile/下次投递可原子认领）。
    const stuck = hooked.allRows().find((row) => row.id === "employee_trigger:t1");
    expect(["leased", "running"]).toContain(stuck?.status);
    expect(stuck?.lease_expires_at == null).toBe(true);

    // resume：解封（生产为 register(activate) 全新代次），再投递必须恢复——
    // 旧触发由本窗口按 FIFO 认领并收敛到终态（回收链路可用）。
    const second = await bounded(
      runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:after-resume" })),
    );
    expect(second).toMatchObject({ outcome: "completed" });
    expect(hooked.openCount()).toBeGreaterThan(1); // 死会话未被复用，全新代次
    expect(calls).toBeGreaterThanOrEqual(2); // 旧触发被重新驱动
    for (const row of hooked.allRows()) {
      expect(["completed", "failed", "waiting"]).toContain(row.status);
    }
    await runtime.stop();
  }, 10_000);

  test("看门狗兜底：无失效通知时悬挂窗口也有界收敛（window-lease-expired），lane 恢复可调度", async () => {
    const handlers = new Map<string, TriggerHandler>();
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      windowDeadlineMs: 40,
    });
    runtime.start();

    let calls = 0;
    handlers.set("qa-probe", async () => {
      calls += 1;
      if (calls === 1) await new Promise<never>(() => undefined); // SDK 死挂语义
      return { probe: true, call: calls };
    });

    const first = runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:hang" }));
    await bounded(expect(first).resolves.toMatchObject({
      outcome: "failed",
      error: "window-lease-expired",
    }));

    // lane 已回到可调度状态：后续投递正常开新窗口并完成
    //（旧悬挂触发也被重新驱动收敛；死会话缓存已被 housekeeping 丢弃）。
    const second = await bounded(
      runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:after-watchdog" })),
      2_000,
    );
    expect(second).toMatchObject({ outcome: "completed" });
    expect(hooked.openCount()).toBeGreaterThanOrEqual(2);
    await runtime.stop();
  }, 10_000);

  // ── D1 二次返工（残余洞）：pause 关闭落在非 driveRun 段 ────────────────

  test("claim 段竞态：pause 关闭落在 claimNextPending 在途时投递有界 failed，后续投递恢复（QA 复现象）", async () => {
    const handlers = new Map<string, TriggerHandler>();
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions({
      onSessionClosed: (database, employeeId) =>
        runtime.invalidateSession({ database, employeeId }),
    });
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      // 大 deadline：收敛只可能来自「失效即拒」立即路径，排除兜底竞速。
      sessionOpDeadlineMs: 60_000,
      // 窗口互斥行短租约：失效路径上 release 写不进死会话，行按 lease TTL 自愈。
      leaseTtlMs: 40,
    });
    runtime.start();
    handlers.set("qa-probe", async () => ({ probe: true }));

    // 取件 SELECT 永不 settle（pause 的 close 正落在它在途时——QA 复现象：
    // 楔形在 windowPlanned/lane.tail，而非 driveRun 段）。
    const hungInClaim = new Promise<void>((resolve) => hooked.hangMatching(/FROM employee_trigger/, resolve));
    const first = runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:claim-hang" }));
    await bounded(hungInClaim, 2_000); // 确认已挂在取件查询上
    // pause：生命周期关闭会话——失效通知落在在途窗口内。
    await hooked.sessions.close("ws_a", "user:ve_1", { deactivate: true });
    await bounded(expect(first).resolves.toMatchObject({
      outcome: "failed",
      error: "employee-session-closed",
    }));

    // 夹具行仍 pending（从未被认领）；解除悬挂后 lane 必须已回到可调度状态。
    expect(hooked.allRows()).toHaveLength(1);
    hooked.hangMatching(null);

    // resume 后新代次全新会话：同一次投递语义的后续请求恢复 completed。
    const second = await bounded(
      runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:after-claim" })),
      2_000,
    );
    expect(second).toMatchObject({ outcome: "completed" });
    expect(hooked.openCount()).toBeGreaterThanOrEqual(2);
    for (const row of hooked.allRows()) {
      expect(["completed", "failed", "waiting"]).toContain(row.status);
    }
    await runtime.stop();
  }, 10_000);

  test("persist 段竞态：pause 关闭落在 enqueue 落库在途时投递有界 failed 且 persist 链自愈", async () => {
    const handlers = new Map<string, TriggerHandler>();
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions({
      onSessionClosed: (database, employeeId) =>
        runtime.invalidateSession({ database, employeeId }),
    });
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      sessionOpDeadlineMs: 30, // persist 无窗口上下文：硬截止兜底（失效即拒不适用）
    });
    runtime.start();
    handlers.set("qa-probe", async () => ({ probe: true }));

    // INSERT 永不 settle：投递调用方不得无限悬挂（D1 合同 3）。
    const hungInPersist = new Promise<void>((resolve) => hooked.hangMatching(/INSERT INTO employee_trigger/, resolve));
    const first = runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:persist-hang" }));
    await bounded(hungInPersist, 2_000); // 确认已挂在落库查询上
    await hooked.sessions.close("ws_a", "user:ve_1", { deactivate: true });
    await bounded(expect(first).resolves.toMatchObject({
      outcome: "failed",
      error: "employee-session-closed",
    }));
    expect(hooked.allRows()).toHaveLength(0); // 落库从未完成，不落库
    hooked.hangMatching(null);

    // persist 链已自愈：后续投递不再被悬挂的落库任务阻塞。
    const second = await bounded(
      runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:after-persist" })),
      2_000,
    );
    expect(second).toMatchObject({ outcome: "completed" });
    await runtime.stop();
  }, 10_000);

  test("无失效通知的会话死亡：护栏硬截止兜底收敛，lane 恢复可调度", async () => {
    const handlers = new Map<string, TriggerHandler>();
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions(); // 不发 onSessionClosed（网络死亡场景）
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      sessionOpDeadlineMs: 30,
      windowDeadlineMs: 5_000, // 兜底的是查询护栏，不是窗口看门狗
    });
    runtime.start();
    handlers.set("qa-probe", async () => ({ probe: true }));

    hooked.hangMatching(/FROM employee_trigger/);
    const first = runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:no-notify" }));
    await bounded(expect(first).resolves.toMatchObject({
      outcome: "failed",
      error: "employee-session-closed", // 归一化错误码，不透出 SDK 原始串
    }));
    hooked.hangMatching(null);

    const second = await bounded(
      runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:after-deadline" })),
      2_000,
    );
    expect(second).toMatchObject({ outcome: "completed" });
    await runtime.stop();
  }, 10_000);
});

describe("D1 原回归：pause 中投递与 retire 拒绝", () => {
  test("pause 中投递：快速 failed(employee-session-blocked) 且触发不落库", async () => {
    const handlers = new Map<string, TriggerHandler>();
    handlers.set("qa-probe", async () => ({ probe: true }));
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
    });
    runtime.start();

    // 员工被暂停：SIGNIN 拒绝（生产 EmployeeRuntime.openSession 语义）。
    hooked.blockOpen(new Error("employee-session-blocked"));
    const result = await bounded(runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:paused" })));
    expect(result).toMatchObject({ outcome: "failed", error: "employee-session-blocked" });
    expect(hooked.allRows()).toHaveLength(0); // 不落库
    await runtime.stop();
  }, 10_000);

  test("retire 后投递：同样拒绝且不落库", async () => {
    const handlers = new Map<string, TriggerHandler>();
    handlers.set("qa-probe", async () => ({ probe: true }));
    const { factory } = fakeDriver(handlers);
    const hooked = fakeSessions();
    const runtime = createEmployeeTriggerRuntime({
      sessions: hooked.sessions,
      driver: factory,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
    });
    runtime.start();
    hooked.blockOpen(new Error("employee-session-blocked"));
    const result = await bounded(runtime.enqueue(delivery({ idempotencyKey: "qa-probe:ve_1:retired" })));
    expect(result).toMatchObject({ outcome: "failed" });
    expect(hooked.allRows()).toHaveLength(0);
    await runtime.stop();
  }, 10_000);
});
