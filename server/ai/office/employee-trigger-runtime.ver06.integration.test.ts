import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime } from "./employee-runtime";
import { createEmployeeTriggerRuntime } from "./employee-trigger-runtime";
import { createEmployeeRuntimeSupervisor } from "./employee-supervisor";

/**
 * VER06 真实库集成测试：自起 --allow-all SurrealDB + 完整 workspace template，验证
 * - 关停限时：stop(deadlineMs) 到点对在途窗口下发 abort（Mastra run.cancel →
 *   snapshot canceled），触发 lease 清回可回收态、employee_window 互斥释放，
 *   新进程 reconcile 立即把触发收敛为终态（不依赖 LIVE/内存通知）；
 * - 启动监督：supervisor 以有界并发枚举 active workspace × active 员工并
 *   reconcile，进度计数含失败明细；
 * - 观测：metrics() 聚合会话/触发/窗口/关停计数，无任何凭证字段。
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
  const database = "ws_ver06";
  const root = new Surreal();
  opened.push(root);
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
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
      CREATE user:ve_idle CONTENT {
        email: "ve-idle@virtual.local", subject: "ve-idle",
        kind: "virtual", is_admin: false, display_name: "闲置专员",
        virtual_profile: { status: "paused", role_key: "idle" }
      };
      INSERT INTO employee_credential {
        employee: user:ve_slow, secret: "ver06-pass", created_at: time::now()
      };
    `).collect();
    fixtureCleanup.push(() => { proc.kill(); });
    return { url, namespace, password, root, database };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
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

describe("employee trigger runtime VER06 against real SurrealDB", () => {
  test("关停到点 abort：run.cancel → lease 释放 → 新进程 reconcile 收敛为 failed", async () => {
    const fixture = await setupFixture();
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
      // 挂起 handler：永不完工，只有 abort 才能终止窗口。
      await new Promise<never>(() => {});
      return {};
    });
    triggerRuntime.start();

    const enqueued = triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: "user:ve_slow",
      reason: "daily-claims-risk",
      payloadRef: "2026-09-30",
      idempotencyKey: "ver06-hang:1",
    });

    // 等窗口拿到 lease、驱动到 run.start（轮询触发行 status=running）。
    let row: { status?: unknown; run_id?: unknown } | undefined;
    for (let i = 0; i < 100; i++) {
      const [rows] = await fixture.root.query<[{ status?: unknown; run_id?: unknown }[]]>(
        "SELECT status, run_id FROM employee_trigger WHERE idempotency_key = 'ver06-hang:1';",
      );
      row = rows?.[0];
      if (row && String(row.status) === "running") break;
      await Bun.sleep(50);
    }
    expect(String(row?.status)).toBe("running");
    const runId = String(row?.run_id);

    // enqueue 的 promise 等触发到终态才结算：窗口挂起时它必然 pending，
    // stop 会把未决 waiter 结算为失败——先停再收它。
    await triggerRuntime.stop({ deadlineMs: 100 });
    const enq = await Promise.race([
      enqueued,
      Bun.sleep(10_000).then(() => "timeout" as const),
    ]);
    expect(enq).not.toBe("timeout");
    expect(enq).toMatchObject({ outcome: "failed" });

    // 生产装配接线断言：真实 EmployeeRuntime 的 sessionStats() 必须透传到
    // metrics().connections / sessions.open（命名错位会让运维指标静默归零）。
    const m = triggerRuntime.metrics();
    expect(m.connections.connects).toBeGreaterThanOrEqual(1);
    expect(m.sessions.open).toBe(m.connections.activeSessions);

    // 等 Mastra cancel 把 snapshot 落 canceled（abort 是异步 best-effort）。
    let snapshotStatus = "";
    const probe = createMastraEmployeeDriver({
      session: { query: (sql: string, params?: Record<string, unknown>) => fixture.root.query(sql, params) },
      database: fixture.database,
      employeeId: "user:ve_slow",
      resolveHandler: () => undefined,
      gates: {
        forTrigger: () => {
          throw new Error("not needed");
        },
      },
    });
    for (let i = 0; i < 100; i++) {
      const state = await probe.loadRunState(runId);
      snapshotStatus = state ? String(state.status) : "missing";
      if (snapshotStatus === "canceled") break;
      await Bun.sleep(50);
    }
    expect(snapshotStatus).toBe("canceled");

    // 触发 lease 已清回、窗口互斥已释放。
    const [triggerRows] = await fixture.root.query<[{ status?: unknown; lease_expires_at?: unknown }[]]>(
      "SELECT status, lease_expires_at FROM employee_trigger WHERE idempotency_key = 'ver06-hang:1';",
    );
    const trigger = triggerRows?.[0];
    expect(["leased", "running"]).toContain(String(trigger?.status));
    expect(trigger?.lease_expires_at == null || String(trigger?.lease_expires_at) === "None").toBe(true);
    const [windowRows] = await fixture.root.query<[{ holder?: unknown; lease_expires_at?: unknown }[]]>(
      "SELECT holder, lease_expires_at FROM employee_window WHERE employee = user:ve_slow;",
    );
    const window = windowRows?.[0];
    expect(window?.holder == null).toBe(true);

    // 新 runtime（模拟重启）reconcile：canceled snapshot → 触发收敛 failed。
    const runtime2 = createEmployeeRuntime({
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
      rootSession: (database) => rootSession(fixture, database),
    });
    const triggerRuntime2 = createEmployeeTriggerRuntime({
      sessions: runtime2,
      driver: createMastraEmployeeDriver,
    });
    triggerRuntime2.registerHandler("daily-claims-risk", async () => ({ ok: true }));
    triggerRuntime2.start();
    const summary = await triggerRuntime2.reconcile({
      database: fixture.database,
      employeeId: "user:ve_slow",
    });
    expect(summary.reclaimed).toBe(1);
    const [finalRows] = await fixture.root.query<[{ status?: unknown; error_message?: unknown }[]]>(
      "SELECT status, error_message FROM employee_trigger WHERE idempotency_key = 'ver06-hang:1';",
    );
    expect(String(finalRows?.[0]?.status)).toBe("failed");
    expect(String(finalRows?.[0]?.error_message)).toContain("canceled");

    const metrics = triggerRuntime.metrics();
    expect(metrics.shutdown.timedOut).toBe(true);
    expect(metrics.shutdown.abortedWindows).toBe(1);
    await triggerRuntime2.stop();
    await runtime.stop();
    await runtime2.stop();
  });

  test("启动监督：枚举 active workspace×active 员工 → reconcile 孤儿触发", async () => {
    const fixture = await setupFixture();
    // 先用员工会话写一条 pending 触发（模拟进程崩溃留下的孤儿）。
    const runtime = createEmployeeRuntime({
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
      rootSession: (database) => rootSession(fixture, database),
    });
    const session = await runtime.openSession(fixture.database, "user:ve_slow");
    await session.query(
      `CREATE employee_trigger CONTENT {
        employee: user:ve_slow, reason: "daily-claims-risk", chain_depth: 0,
        idempotency_key: "ver06-orphan:1", status: "leased",
        lease_expires_at: time::now() - 1s, attempts: 1, run_id: "er-orphan"
      };`,
    );

    const triggerRuntime = createEmployeeTriggerRuntime({
      sessions: runtime,
      driver: createMastraEmployeeDriver,
    });
    triggerRuntime.registerHandler("daily-claims-risk", async ({ session: s }) => {
      await s.query("CREATE trigger_effect CONTENT { k: 'recovered' };");
      return { recovered: true };
    });
    triggerRuntime.start();

    const supervisor = createEmployeeRuntimeSupervisor({
      runtime: triggerRuntime,
      sessions: runtime,
      listWorkspaces: async () => [fixture.database],
      listActiveEmployees: async (db) => {
        const root = await rootSession(fixture, db);
        const [rows] = await root.query<[{ id?: unknown }[]]>(
          'SELECT id FROM user WHERE kind = "virtual" AND virtual_profile.status = "active";',
        );
        return (rows ?? []).map((r) => String(r.id)).filter(Boolean);
      },
      concurrency: 2,
    });
    const progress = await supervisor.start();
    expect(progress.state).toBe("done");
    // active 员工只有 ve_slow（ve_idle 是 suspended，不被枚举）。
    expect(progress.employeesTotal).toBe(1);
    expect(progress.employeesReconciled).toBe(1);
    expect(progress.employeesFailed).toBe(0);

    // orphan 触发被 reconcile 回收并执行完成；ve_idle 的 lane 没建。
    const [rows] = await fixture.root.query<[{ status?: unknown }[]]>(
      "SELECT status FROM employee_trigger WHERE idempotency_key = 'ver06-orphan:1';",
    );
    // snapshot 缺失（run_id er-orphan 没有 snapshot）→ 走 start 路径 → handler 完成。
    expect(String(rows?.[0]?.status)).toBe("completed");
    const [effects] = await fixture.root.query<[{ k?: unknown }[]]>(
      "SELECT k FROM trigger_effect WHERE k = 'recovered';",
    );
    expect(effects).toHaveLength(1);
    await triggerRuntime.stop();
    await runtime.stop();
  });
});
