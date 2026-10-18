import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { Workflow } from "@mastra/core/workflows";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { SurrealWorkflowsStorage } from "../mastra/storage/surreal-workflows-storage";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime } from "./employee-runtime";
import { createEmployeeTriggerRuntime, type TriggerSessionManager } from "./employee-trigger-runtime";

/**
 * VER06 关停门禁的确定性红测，跑在公司 fork 的隔离临时库上。
 *
 * 每个用例都用真实调用接缝（Mastra workflow.createRun、SurrealWorkflowsStorage.persistWorkflowSnapshot）
 * 上的 deferred 栅栏制造竞态，不靠固定 sleep 诱发：
 * - activeRun 空窗：run 尚未由 createRun 返回时到点 stop，中止请求不得丢失；run 创建后必须立即取消，
 *   handler 不得执行，快照落 canceled。
 * - teardown 次序：canceled 快照写库未完成时，stop 不得结束、员工会话不得被关闭。
 * - 幂等与终态：重复 stop 只取消一次；run 已正常完成后的 driver.abort 不得把成功快照改写为 canceled。
 * - 共享宽限：1 与 8 个 lane 的在途中止共用同一次停机宽限（虚拟钟逐次推进，员工会话查询被闸门挂起）。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
  // 先结束测试库进程，再有界关闭会话：服务端已断开的连接不会再挂起关闭，关闭超时也不拖垮 afterEach 钩子。
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
  await closeWithin(opened.splice(0), 3_000);
});

async function closeWithin(dbs: Surreal[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([Promise.allSettled(dbs.map((db) => db.close())), limit]);
  clearTimeout(timer);
}

type Fixture = {
  url: string;
  namespace: string;
  password: string;
  root: Surreal;
  database: string;
};

async function setupFixture(): Promise<Fixture> {
  const port = 24000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const namespace = "main";
  const database = "ws_ver06_gate";
  const root = new Surreal();
  opened.push(root);
  fixtureCleanup.push(() => {
    proc.kill();
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      /* startup */
    }
    await Bun.sleep(50);
  }
  const url = `ws://127.0.0.1:${port}/rpc`;
  await root.connect(url);
  await root.signin({ username: "test", password });
  const scripts = await loadTemplateScripts({ oidcJwksUrl: "https://idp.example.test/jwks" });
  await root.query(`USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database};`).collect();
  await root.use({ namespace, database });
  for (const script of scripts) await root.query(script.sql).collect();
  await root.query(`
    DEFINE TABLE trigger_effect SCHEMALESS PERMISSIONS FOR select, create WHERE $auth != NONE;
    CREATE user:ve_slow CONTENT {
      email: "ve-slow@virtual.local", subject: "ve-slow",
      kind: "virtual", is_admin: false, display_name: "慢速专员",
      virtual_profile: { status: "active", role_key: "slow" }
    };
    INSERT INTO employee_credential {
      employee: user:ve_slow, secret: "ver06-pass", created_at: time::now()
    };
  `).collect();
  return { url, namespace, password, root, database };
}

async function rootSession(fixture: Fixture, database: string) {
  const session = new Surreal();
  opened.push(session);
  await session.connect(fixture.url);
  await session.signin({ username: "test", password: fixture.password });
  await session.use({ namespace: fixture.namespace, database });
  return {
    query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>) {
      return session.query(sql, params) as Promise<R>;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

const isNone = (value: unknown): boolean => value == null || String(value) === "None";

async function triggerRow(root: Surreal, key: string) {
  const [rows] = await root.query<[{ status?: unknown; run_id?: unknown; lease_expires_at?: unknown }[]]>(
    "SELECT status, run_id, lease_expires_at FROM employee_trigger WHERE idempotency_key = $key;",
    { key },
  );
  return rows?.[0];
}

async function snapshotStatus(root: Surreal, runId: string): Promise<string> {
  const [rows] = await root.query<[{ status?: unknown }[]]>(
    "SELECT status FROM workflow_run WHERE run_id = $runId;",
    { runId },
  );
  return String(rows?.[0]?.status ?? "missing");
}

/** 计数真实 createRun 返回的 run 上的 cancel 调用（包装实例属性，不替换 driver.abort）。 */
function countRunCancels(counter: { calls: number }) {
  const original = Workflow.prototype.createRun;
  return spyOn(Workflow.prototype, "createRun").mockImplementation(async function (
    this: unknown,
    ...args: unknown[]
  ) {
    const run = (await (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args)) as {
      cancel: () => Promise<void>;
    };
    const cancel = run.cancel.bind(run);
    run.cancel = async () => {
      counter.calls += 1;
      return cancel();
    };
    return run;
  });
}

describe("VER06 关停门禁：确定性红测（公司 fork 隔离库）", () => {
  test("createRun 挂起期间到点 stop：run 创建后立即取消，handler 不执行，快照落 canceled", async () => {
    const fixture = await setupFixture();
    const original = Workflow.prototype.createRun;
    const held = deferred();
    const entered = deferred();
    let holdNext = true;
    let handlerCalls = 0;
    const spy = spyOn(Workflow.prototype, "createRun").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (holdNext) {
        holdNext = false;
        entered.resolve();
        await held.promise;
      }
      return (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    });
    try {
      const runtime = createEmployeeRuntime({
        surrealUrl: fixture.url,
        namespace: fixture.namespace,
        rootSession: (database) => rootSession(fixture, database),
      });
      const triggerRuntime = createEmployeeTriggerRuntime({
        sessions: runtime,
        driver: createMastraEmployeeDriver,
        abortGraceMs: 2_000,
      });
      triggerRuntime.registerHandler("daily-claims-risk", async () => {
        handlerCalls += 1;
        await new Promise<never>(() => {});
        return {};
      });
      triggerRuntime.start();
      const key = "gate-pending:1";
      const enqueued = triggerRuntime.enqueue({
        database: fixture.database,
        employeeId: "user:ve_slow",
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        idempotencyKey: key,
      });

      await entered.promise;
      // 运行状态先于 driver.start：此刻触发行已是 running，而 run 尚未由 createRun 返回。
      const pending = await triggerRow(fixture.root, key);
      expect(String(pending?.status)).toBe("running");
      const runId = String(pending?.run_id);

      const stopping = triggerRuntime.stop({ deadlineMs: 0 });
      // 窗口侧中止已下发：触发租约被清回。等待的是状态转移，不是固定睡眠。
      expect(await waitUntil(async () => isNone((await triggerRow(fixture.root, key))?.lease_expires_at))).toBe(true);
      held.resolve();
      await stopping;
      expect(await enqueued).toMatchObject({ outcome: "failed" });

      await waitUntil(async () => (await snapshotStatus(fixture.root, runId)) === "canceled");
      expect({ handlerCalls, snapshot: await snapshotStatus(fixture.root, runId) }).toEqual({
        handlerCalls: 0,
        snapshot: "canceled",
      });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("canceled 快照写库未完成前 stop 不结束：员工会话不得在写库途中被关闭", async () => {
    const fixture = await setupFixture();
    const originalPersist = SurrealWorkflowsStorage.prototype.persistWorkflowSnapshot;
    const writing = deferred();
    const release = deferred();
    const handlerStarted = deferred();
    let heldOnce = false;
    const spy = spyOn(SurrealWorkflowsStorage.prototype, "persistWorkflowSnapshot").mockImplementation(async function (
      this: unknown,
      args: Parameters<SurrealWorkflowsStorage["persistWorkflowSnapshot"]>[0],
    ) {
      if (!heldOnce && args.snapshot.status === "canceled") {
        heldOnce = true;
        writing.resolve();
        await release.promise;
      }
      return (originalPersist as unknown as (...a: unknown[]) => Promise<void>).call(this, args);
    });
    try {
      const runtime = createEmployeeRuntime({
        surrealUrl: fixture.url,
        namespace: fixture.namespace,
        rootSession: (database) => rootSession(fixture, database),
      });
      const triggerRuntime = createEmployeeTriggerRuntime({
        sessions: runtime,
        driver: createMastraEmployeeDriver,
        abortGraceMs: 2_000,
      });
      triggerRuntime.registerHandler("daily-claims-risk", async () => {
        handlerStarted.resolve();
        await new Promise<never>(() => {});
        return {};
      });
      triggerRuntime.start();
      const key = "gate-writing:1";
      const enqueued = triggerRuntime.enqueue({
        database: fixture.database,
        employeeId: "user:ve_slow",
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        idempotencyKey: key,
      });

      await handlerStarted.promise;
      const runId = String((await triggerRow(fixture.root, key))?.run_id);
      const stopping = triggerRuntime.stop({ deadlineMs: 0 });
      const written = await Promise.race([writing.promise.then(() => "writing" as const), Bun.sleep(5_000).then(() => "not-reached" as const)]);
      expect(written).toBe("writing");

      // 写库仍在途：stop 不得先行结束（即不得先关闭会话）。
      const early = await Promise.race([
        stopping.then(() => "stopped" as const),
        Bun.sleep(400).then(() => "pending" as const),
      ]);
      expect(early).toBe("pending");

      release.resolve();
      await stopping;
      expect(await enqueued).toMatchObject({ outcome: "failed" });
      expect(await waitUntil(async () => (await snapshotStatus(fixture.root, runId)) === "canceled")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("关停到点重复 stop：挂起 run 只取消一次", async () => {
    const fixture = await setupFixture();
    const cancels = { calls: 0 };
    const spy = countRunCancels(cancels);
    const handlerStarted = deferred();
    try {
      const runtime = createEmployeeRuntime({
        surrealUrl: fixture.url,
        namespace: fixture.namespace,
        rootSession: (database) => rootSession(fixture, database),
      });
      const triggerRuntime = createEmployeeTriggerRuntime({
        sessions: runtime,
        driver: createMastraEmployeeDriver,
        abortGraceMs: 2_000,
      });
      triggerRuntime.registerHandler("daily-claims-risk", async () => {
        handlerStarted.resolve();
        await new Promise<never>(() => {});
        return {};
      });
      triggerRuntime.start();
      const key = "gate-twice:1";
      const enqueued = triggerRuntime.enqueue({
        database: fixture.database,
        employeeId: "user:ve_slow",
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        idempotencyKey: key,
      });
      await handlerStarted.promise;
      const runId = String((await triggerRow(fixture.root, key))?.run_id);
      const first = triggerRuntime.stop({ deadlineMs: 0 });
      const second = triggerRuntime.stop({ deadlineMs: 0 });
      await Promise.all([first, second]);
      expect(await enqueued).toMatchObject({ outcome: "failed" });
      expect(await waitUntil(async () => (await snapshotStatus(fixture.root, runId)) === "canceled")).toBe(true);
      expect(cancels.calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("终态不误取消：run 正常完成后 driver.abort 不得把成功快照改写为 canceled", async () => {
    const fixture = await setupFixture();
    const cancels = { calls: 0 };
    const spy = countRunCancels(cancels);
    const runtime = createEmployeeRuntime({
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
      rootSession: (database) => rootSession(fixture, database),
    });
    try {
      // 员工会话（与生产 openSession 一致）：快照的 owner 由员工身份写入，root 会话不满足表约束。
      const session = await runtime.openSession(fixture.database, "user:ve_slow");
      const driver = createMastraEmployeeDriver({
        session: session as unknown as Parameters<typeof createMastraEmployeeDriver>[0]["session"],
        database: fixture.database,
        employeeId: "user:ve_slow",
        resolveHandler: (reason) => (reason === "daily-claims-risk" ? async () => ({ ok: true }) : undefined),
        gates: { forTrigger: () => ({}) } as unknown as Parameters<typeof createMastraEmployeeDriver>[0]["gates"],
      });
      const runId = "er-employee_trigger:term1";
      const trigger = {
        id: "employee_trigger:term1",
        database: fixture.database,
        employeeId: "user:ve_slow",
        reason: "daily-claims-risk",
        payloadRef: null,
        chainDepth: 0,
        idempotencyKey: "term:1",
        runId,
      };
      const result = await driver.start({ runId, trigger });
      expect(result).toMatchObject({ status: "success" });
      await driver.abort?.();
      expect(cancels.calls).toBe(0);
      expect(await snapshotStatus(fixture.root, runId)).toBe("success");
    } finally {
      spy.mockRestore();
      // 关闭本用例打开的员工会话，避免续约与重连订阅残留到后续用例。
      await runtime.stop().catch(() => undefined);
    }
  }, 30_000);
});

const SHARED_GRACE_MS = 2_000;

/** 虚拟钟：sleep 只在测试推进时返回，停机宽限由测试逐次推进，不依赖真实等待。 */
function virtualClock() {
  let elapsed = 0;
  let timers: Array<{ at: number; resolve: () => void }> = [];
  return {
    sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        timers.push({ at: elapsed + ms, resolve });
      });
    },
    pending: () => timers.length,
    elapsed: () => elapsed,
    advance(ms: number): void {
      elapsed += ms;
      const due = timers.filter((timer) => timer.at <= elapsed);
      timers = timers.filter((timer) => timer.at > elapsed);
      for (const timer of due) timer.resolve();
    },
  };
}

/** 查询闸：engage 之后员工会话上的每次 query 都挂起，直到 release（模拟中止后数据库不再响应）。 */
function queryHold() {
  const released = deferred();
  let engaged = false;
  return {
    engage: () => {
      engaged = true;
    },
    release: () => released.resolve(),
    pass: async (): Promise<void> => {
      if (engaged) await released.promise;
    },
  };
}

/** 员工会话包装：query 经查询闸放行，其余成员绑定到真实会话原样透出。 */
function holdingSession(session: Surreal, hold: ReturnType<typeof queryHold>): Surreal {
  return new Proxy(session, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string, params?: Record<string, unknown>) => hold.pass().then(() => target.query(sql, params));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function addEmployees(fixture: Fixture, count: number): Promise<string[]> {
  const ids: string[] = [];
  const statements: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `ve_gate_${i}`;
    ids.push(`user:${id}`);
    statements.push(
      `CREATE user:${id} CONTENT { email: "${id}@virtual.local", subject: "${id}", kind: "virtual", is_admin: false, display_name: "门禁专员${i}", virtual_profile: { status: "active", role_key: "gate" } };`,
      `INSERT INTO employee_credential { employee: user:${id}, secret: "ver06-pass", created_at: time::now() };`,
    );
  }
  await fixture.root.query(statements.join("\n")).collect();
  return ids;
}

const settledWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);

/**
 * 共享宽限场景：laneCount 个 lane 各有一个挂起的 run。到点中止后员工会话的查询全部挂起
 * （窗口收尾与 canceled 快照写库都无法结算），宽限只由虚拟钟推进一次。
 */
async function sharedGraceScenario(laneCount: number) {
  const fixture = await setupFixture();
  const employeeIds = await addEmployees(fixture, laneCount);
  const cancels = { calls: 0 };
  const cancelSpy = countRunCancels(cancels);
  const canceledWrites = { calls: 0 };
  const originalPersist = SurrealWorkflowsStorage.prototype.persistWorkflowSnapshot;
  const persistSpy = spyOn(SurrealWorkflowsStorage.prototype, "persistWorkflowSnapshot").mockImplementation(async function (
    this: unknown,
    args: Parameters<SurrealWorkflowsStorage["persistWorkflowSnapshot"]>[0],
  ) {
    if (args.snapshot.status === "canceled") canceledWrites.calls += 1;
    return (originalPersist as unknown as (...a: unknown[]) => Promise<void>).call(this, args);
  });
  const closes = { calls: 0 };
  const clock = virtualClock();
  const hold = queryHold();
  let stopping: Promise<void> | undefined;
  const runtime = createEmployeeRuntime({
    surrealUrl: fixture.url,
    namespace: fixture.namespace,
    rootSession: (database) => rootSession(fixture, database),
  });
  try {
    const sessions: TriggerSessionManager = {
      async openSession(database, employeeId) {
        const session = await runtime.openSession(database, employeeId);
        return holdingSession(session, hold) as unknown as Awaited<ReturnType<TriggerSessionManager["openSession"]>>;
      },
      async close(database, employeeId) {
        closes.calls += 1;
        return runtime.close(database, employeeId);
      },
    };
    const triggerRuntime = createEmployeeTriggerRuntime({
      sessions,
      driver: createMastraEmployeeDriver,
      abortGraceMs: SHARED_GRACE_MS,
      sessionOpDeadlineMs: 60_000,
      sleep: clock.sleep,
    });
    let handlerStarts = 0;
    triggerRuntime.registerHandler("daily-claims-risk", async () => {
      handlerStarts += 1;
      await new Promise<never>(() => {});
      return {};
    });
    triggerRuntime.start();
    const enqueued = employeeIds.map((employeeId, index) =>
      triggerRuntime.enqueue({
        database: fixture.database,
        employeeId,
        reason: "daily-claims-risk",
        payloadRef: "2026-09-30",
        idempotencyKey: `grace:${laneCount}:${index}`,
      }),
    );
    expect(await waitUntil(async () => handlerStarts === laneCount)).toBe(true);

    // 中止之后数据库不再响应：员工会话的每次查询（含 canceled 写库与窗口收尾）都挂起。
    hold.engage();
    stopping = triggerRuntime.stop({ deadlineMs: 0 });
    expect(triggerRuntime.stop({ deadlineMs: 0 })).toBe(stopping);
    clock.advance(0); // 到点：只推进到 deadline，不推进宽限
    expect(await waitUntil(async () => cancels.calls === laneCount)).toBe(true);
    expect(await waitUntil(async () => clock.pending() > 0)).toBe(true);
    await Bun.sleep(100);
    // 宽限未到：在途中止未结算，会话不得关闭，stop 不得结束。
    expect({ closes: closes.calls, settled: await settledWithin(stopping, 0) }).toEqual({ closes: 0, settled: false });

    // 宽限只推进一次：全部会话应在这一次到点后关闭，stop 随之结束，不再等待额外的宽限。
    clock.advance(SHARED_GRACE_MS);
    expect(await waitUntil(async () => closes.calls === laneCount, 3_000)).toBe(true);
    expect(await settledWithin(stopping, 3_000)).toBe(true);
    expect(clock.elapsed()).toBe(SHARED_GRACE_MS);
    const shutdown = triggerRuntime.metrics().shutdown;
    expect({
      timedOut: shutdown.timedOut,
      abortedWindows: shutdown.abortedWindows,
      abandonedAborts: shutdown.abandonedAborts,
    }).toEqual({ timedOut: true, abortedWindows: laneCount, abandonedAborts: laneCount });

    // 释放数据库后的迟到结果：不重复取消、不重复写 canceled、不重复关闭会话。
    // 放弃的中止仍挂在查询闸后；释放后只会在已关闭的连接上失败，不得产生新的取消、写库或关闭。
    const atBudget = { cancels: cancels.calls, canceledWrites: canceledWrites.calls, closes: closes.calls };
    expect({ cancels: atBudget.cancels, closes: atBudget.closes }).toEqual({ cancels: laneCount, closes: laneCount });
    expect(atBudget.canceledWrites).toBeLessThanOrEqual(laneCount);
    hold.release();
    expect((await Promise.all(enqueued)).map((result) => result.outcome)).toEqual(employeeIds.map(() => "failed"));
    await Bun.sleep(100);
    expect({ cancels: cancels.calls, canceledWrites: canceledWrites.calls, closes: closes.calls }).toEqual(atBudget);
  } finally {
    // 失败路径也要放行挂起的查询并推进虚拟钟，避免残留停机任务阻塞后续用例。
    hold.release();
    for (let i = 0; i < laneCount + 2; i++) {
      clock.advance(SHARED_GRACE_MS);
      await Bun.sleep(10);
    }
    if (stopping) await settledWithin(stopping, 5_000);
    // 停止本场景的员工运行时，释放会话续约与重连订阅，避免残留后台任务影响同进程后续用例。
    await settledWithin(runtime.stop(), 5_000);
    cancelSpy.mockRestore();
    persistSpy.mockRestore();
  }
}

describe("VER06 关停门禁：共享宽限预算（公司 fork 隔离库）", () => {
  test("1 lane：在途中止的宽限到点一次即收尾，会话关闭且 stop 结束", async () => {
    await sharedGraceScenario(1);
  }, 60_000);

  test("8 lane：在途中止共享同一次宽限，到点不随 lane 数线性累加", async () => {
    await sharedGraceScenario(8);
  }, 60_000);
});
