import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { Workflow } from "@mastra/core/workflows";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { SurrealWorkflowsStorage } from "../mastra/storage/surreal-workflows-storage";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime } from "./employee-runtime";
import { createEmployeeTriggerRuntime } from "./employee-trigger-runtime";

/**
 * VER06 关停门禁的确定性红测，跑在公司 fork 的隔离临时库上。
 *
 * 每个用例都用真实调用接缝（Mastra workflow.createRun、SurrealWorkflowsStorage.persistWorkflowSnapshot）
 * 上的 deferred 栅栏制造竞态，不靠固定 sleep 诱发：
 * - activeRun 空窗：run 尚未由 createRun 返回时到点 stop，中止请求不得丢失；run 创建后必须立即取消，
 *   handler 不得执行，快照落 canceled。
 * - teardown 次序：canceled 快照写库未完成时，stop 不得结束、员工会话不得被关闭。
 * - 幂等与终态：重复 stop 只取消一次；run 已正常完成后的 driver.abort 不得把成功快照改写为 canceled。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});

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
    try {
      // 员工会话（与生产 openSession 一致）：快照的 owner 由员工身份写入，root 会话不满足表约束。
      const runtime = createEmployeeRuntime({
        surrealUrl: fixture.url,
        namespace: fixture.namespace,
        rootSession: (database) => rootSession(fixture, database),
      });
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
    }
  }, 30_000);
});
