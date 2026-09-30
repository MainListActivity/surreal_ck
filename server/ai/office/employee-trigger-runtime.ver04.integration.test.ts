import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime, type EmployeeRuntime } from "./employee-runtime";
import { createEmployeeTriggerRuntime, type TriggerSession } from "./employee-trigger-runtime";

/**
 * VER04 真实库集成测试：自起 --allow-all SurrealDB，完整应用 workspace template
 * （含 036 lease 字段与 employee_effect 账本），员工会话 = 真实 RECORD SIGNIN，
 * workflow run = 真实 Mastra office-employee workflow（snapshot 落本 db
 * workflow_run）。按验收点注入进程丢失的四个崩溃边界，断言：
 * - 认领前崩溃：触发保持 pending，重投递恰好一次副作用；
 * - 认领后崩溃：lease 过期后 reconcile 恢复窗口；
 * - effect 已提交、workflow 未完成时崩溃：restart 重放 step，runEffect
 *   读 committed 账本 → 用户可见副作用恰好一次；
 * - 显式 suspend：触发置 waiting，reconcile 不动，仅 resumeTrigger 恢复。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];
const DB = "ws_ver04";
const EMPLOYEE = "user:claims_risk_reminder";

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});

type Fixture = { url: string; namespace: string; password: string; root: Surreal };

async function setupFixture(): Promise<Fixture> {
  const port = 24000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const root = new Surreal();
  opened.push(root);
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    const namespace = "main";
    await root.connect(url);
    await root.signin({ username: "test", password });
    const scripts = await loadTemplateScripts({ oidcJwksUrl: "https://idp.example.test/jwks" });
    await root.query(`USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${DB};`).collect();
    await root.use({ namespace, database: DB });
    for (const script of scripts) await root.query(script.sql).collect();
    await root.query(`
      CREATE ${EMPLOYEE} CONTENT {
        email: "claims-risk-reminder@virtual.local", subject: "claims-risk-reminder",
        kind: "virtual", is_admin: false, display_name: "债权风险提醒专员",
        virtual_profile: { status: "active", role_key: "claims-risk-reminder" }
      };
      INSERT INTO employee_credential {
        employee: ${EMPLOYEE}, secret: "risk-pass-${DB}", created_at: time::now()
      };
      -- 用户可见副作用的探针表：handler 每做一次业务写落一行。
      DEFINE TABLE trigger_effect SCHEMALESS PERMISSIONS
        FOR select, create WHERE $auth != NONE;
    `).collect();
    fixtureCleanup.push(() => { proc.kill(); });
    return { url, namespace, password, root };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
}

async function realSessions(fixture: Fixture): Promise<EmployeeRuntime> {
  return createEmployeeRuntime({
    surrealUrl: fixture.url,
    namespace: fixture.namespace,
    rootSession: async (database) => {
      const session = new Surreal();
      opened.push(session);
      await session.connect(fixture.url);
      await session.signin({ username: "test", password: fixture.password });
      await session.use({ namespace: fixture.namespace, database });
      return { query: (sql: string, params?: Record<string, unknown>) => session.query(sql, params) };
    },
  });
}

const delivery = (key: string) => ({
  database: DB,
  employeeId: EMPLOYEE,
  reason: "daily-claims-risk",
  payloadRef: "2026-09-30",
  chainDepth: 0,
  idempotencyKey: key,
});

/** 把员工会话包一层，在指定 SQL 形态上一次性抛错 = 窗口中进程断电。 */
function sabotage(runtime: EmployeeRuntime, kill: (sql: string, params: Record<string, unknown>) => boolean) {
  return {
    async openSession(database: string, employeeId: string): Promise<TriggerSession> {
      const session = await runtime.openSession(database, employeeId);
      return {
        async query<R extends unknown[] = unknown[]>(sql: string, params: Record<string, unknown> = {}) {
          if (kill(sql, params)) throw new Error("simulated process loss");
          return session.query(sql, params) as Promise<R>;
        },
      };
    },
    close: (database: string, employeeId: string) => runtime.close(database, employeeId),
  };
}

async function triggerRows(fixture: Fixture) {
  await fixture.root.use({ namespace: fixture.namespace, database: DB });
  const [rows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
    "SELECT id, status, attempts, run_id, lease_expires_at, error_message, idempotency_key FROM employee_trigger;",
  );
  return rows;
}

async function effectWrites(fixture: Fixture) {
  await fixture.root.use({ namespace: fixture.namespace, database: DB });
  const [rows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
    "SELECT effect_key, actor FROM trigger_effect;",
  );
  return rows;
}

describe("VER04 可恢复执行窗口（真实 SurrealDB + 真实 Mastra driver）", () => {
  test("认领前崩溃：触发停 pending，下次投递原子认领并完成，副作用恰好一次", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    let killed = false;
    const sessions = sabotage(employeeRuntime, (sql) => {
      // 认领 UPDATE 一律杀掉——persist 已提交、lease 未写下。
      if (!killed && sql.includes("UPDATE $trigger") && sql.includes('status = "leased"')) {
        killed = true;
        return true;
      }
      return false;
    });
    const runtime = createEmployeeTriggerRuntime({ sessions, driver: createMastraEmployeeDriver });
    runtime.start();
    let businessWrites = 0;
    runtime.registerHandler("daily-claims-risk", async ({ trigger, session, effects }) =>
      effects.runEffect("check", async () => {
        businessWrites += 1;
        await session.query(
          "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
          { key: trigger.idempotencyKey },
        );
        return { remindersCreated: 1 };
      }),
    );

    const crashed = await runtime.enqueue(delivery("k-crash-before-claim"));
    expect(crashed.outcome).toBe("failed");
    expect((await triggerRows(fixture))[0]?.status).toBe("pending");

    // 新"进程"（同一 runtime 实例等价新进程重试路径）再次投递同键
    const ok = await runtime.enqueue(delivery("k-crash-before-claim"));
    expect(ok.outcome).toBe("completed");
    const rows = await triggerRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", attempts: 1 });
    expect(await effectWrites(fixture)).toHaveLength(1);
    expect(businessWrites).toBe(1);
    await runtime.stop();
    await employeeRuntime.stop();
  }, 60_000);

  test("认领后崩溃：lease 持有期间不抢跑，过期后 reconcile 恢复窗口", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    let killed = false;
    const sessions = sabotage(employeeRuntime, (sql, params) => {
      // 认领已过（status="leased" 写入成功），在 setStatus(running) 处断电。
      if (!killed && sql.includes("UPDATE $trigger") && params.status === "running") {
        killed = true;
        return true;
      }
      return false;
    });
    const runtime = createEmployeeTriggerRuntime({
      sessions,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 150,
    });
    runtime.start();
    let businessWrites = 0;
    runtime.registerHandler("daily-claims-risk", async ({ trigger, session, effects }) =>
      effects.runEffect("check", async () => {
        businessWrites += 1;
        await session.query(
          "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
          { key: trigger.idempotencyKey },
        );
        return { remindersCreated: 1 };
      }),
    );

    const crashed = await runtime.enqueue(delivery("k-crash-after-claim"));
    expect(crashed.outcome).toBe("failed");
    let row = (await triggerRows(fixture))[0]!;
    expect(row.status).toBe("leased");
    expect(row.attempts).toBe(1);
    expect(row.run_id).toBeTruthy();

    // lease 未到期：同键投递不抢窗口
    const held = await runtime.enqueue(delivery("k-crash-after-claim"));
    expect(held.outcome).toBe("coalesced");
    expect(businessWrites).toBe(0);

    // lease 过期：reconcile 原子重认领（attempts=2）→ 无 snapshot → start → 完成
    await Bun.sleep(250);
    const summary = await runtime.reconcile({ database: DB, employeeId: EMPLOYEE });
    expect(summary).toMatchObject({ scanned: 1, reclaimed: 1, completed: 1 });
    row = (await triggerRows(fixture))[0]!;
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(2);
    expect(await effectWrites(fixture)).toHaveLength(1);
    expect(businessWrites).toBe(1);
    await runtime.stop();
    await employeeRuntime.stop();
  }, 60_000);

  test("effect 已提交、workflow 未完成时崩溃：restart 重放 step，用户可见副作用恰好一次", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    const runtime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 200,
    });
    runtime.start();
    let handlerCalls = 0;
    let businessWrites = 0;
    runtime.registerHandler("daily-claims-risk", async ({ trigger, session, effects }) => {
      handlerCalls += 1;
      const result = await effects.runEffect("check", async () => {
        businessWrites += 1;
        await session.query(
          "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
          { key: trigger.idempotencyKey },
        );
        return { remindersCreated: 1 };
      });
      if (handlerCalls === 1) {
        // 效果已提交后模拟断电：窗口永远挂起（等价进程退出，durable 状态
        // 停留在 leased/running + snapshot running/缺失）。
        await new Promise(() => {});
      }
      return result;
    });

    // 窗口 1 内进程"断电"：enqueue 永不返回，不 await
    void runtime.enqueue(delivery("k-crash-after-effect")).catch(() => undefined);
    // 等 effect 账本与业务行落库
    let committed: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 100; i++) {
      await fixture.root.use({ namespace: fixture.namespace, database: DB });
      const [rows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
        "SELECT id, status FROM employee_effect WHERE status = 'committed';",
      );
      if ((rows?.length ?? 0) > 0) { committed = rows; break; }
      await Bun.sleep(50);
    }
    expect(committed).toHaveLength(1);
    expect(committed[0]?.status).toBe("committed");
    expect(await effectWrites(fixture)).toHaveLength(1);

    // 进程 2：新 runtime（fresh 串行链）按过期 lease 回收孤儿窗口
    await Bun.sleep(300);
    const recovery = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 200,
    });
    recovery.start();
    recovery.registerHandler("daily-claims-risk", async ({ trigger, session, effects }) => {
      handlerCalls += 1;
      return effects.runEffect("check", async () => {
        businessWrites += 1;
        await session.query(
          "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
          { key: trigger.idempotencyKey },
        );
        return { remindersCreated: 1 };
      });
    });
    const summary = await recovery.reconcile({ database: DB, employeeId: EMPLOYEE });
    expect(summary.reclaimed).toBe(1);
    expect(summary.completed).toBe(1);

    const row = (await triggerRows(fixture))[0]!;
    expect(row.status).toBe("completed");
    // 关键断言：handler 被重放（restart/重跑 step），但业务写仍只有一次——
    // runEffect 读到 committed 账本直接回结果。
    expect(handlerCalls).toBeGreaterThanOrEqual(2);
    expect(businessWrites).toBe(1);
    expect(await effectWrites(fixture)).toHaveLength(1);
    await recovery.stop();
    await employeeRuntime.stop();
  }, 90_000);

  test("显式 suspend → 触发 waiting，reconcile 不动；resumeTrigger 走 resume 完成", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    const runtime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 150,
    });
    runtime.start();
    const writes: string[] = [];
    let handlerCalls = 0;
    runtime.registerHandler("daily-claims-risk", async ({ trigger, session, effects, resumeData, suspend }) => {
      handlerCalls += 1;
      const pre = await effects.runEffect("pre", async () => {
        writes.push("pre");
        await session.query("CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };", {
          key: `${trigger.idempotencyKey}:pre`,
        });
        return { stage: "pre" };
      });
      if (resumeData === undefined) await suspend({ need: "human-approval" });
      await effects.runEffect("post", async () => {
        writes.push("post");
        await session.query("CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };", {
          key: `${trigger.idempotencyKey}:post`,
        });
        return { stage: "post" };
      });
      return { resumedWith: resumeData ?? null, pre };
    });

    const suspended = await runtime.enqueue(delivery("k-suspend"));
    expect(suspended.outcome).toBe("waiting");
    const triggerId = suspended.triggerId!;
    let row = (await triggerRows(fixture))[0]!;
    expect(row.status).toBe("waiting");

    // reconcile 在 lease 过期后也不碰 waiting（显式挂起只能 resume）
    await Bun.sleep(250);
    const summary = await runtime.reconcile({ database: DB, employeeId: EMPLOYEE });
    expect(summary).toMatchObject({ scanned: 0, reclaimed: 0 });
    expect((await triggerRows(fixture))[0]?.status).toBe("waiting");

    const resumed = await runtime.resumeTrigger({
      database: DB,
      employeeId: EMPLOYEE,
      triggerId,
      resumeData: { approved: true },
    });
    expect(resumed.outcome).toBe("completed");
    row = (await triggerRows(fixture))[0]!;
    expect(row.status).toBe("completed");
    // resume 语义：step 从头重放——pre 走账本回结果不重写，post 正常执行。
    expect(handlerCalls).toBe(2);
    expect(writes).toEqual(["pre", "post"]);
    const effectsWritten = await effectWrites(fixture);
    expect(effectsWritten).toHaveLength(2);
    await runtime.stop();
    await employeeRuntime.stop();
  }, 90_000);

  test("单员工至多一个活跃窗口：跨进程第二触发 pending 等位，死窗口被 lease 接管", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    // 进程 A：handler 挂起 = 窗口永远占住（等价断电）；lease 拉长保证 B 首试时仍被持有
    const rtA = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 30_000,
    });
    rtA.start();
    rtA.registerHandler("daily-claims-risk", async () => {
      await new Promise(() => {});
      return {};
    });
    void rtA.enqueue(delivery("k-window-a")).catch(() => undefined);
    // 等 A 认领：employee_window 行出现
    for (let i = 0; i < 100; i++) {
      await fixture.root.use({ namespace: fixture.namespace, database: DB });
      const [rows] = await fixture.root.query<[unknown[]]>("SELECT id FROM employee_window;");
      if ((rows?.length ?? 0) > 0) break;
      await Bun.sleep(50);
    }
    const [windows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
      "SELECT holder, trigger, lease_expires_at FROM employee_window;",
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.holder).toBeTruthy();

    // 进程 B：同员工不同键的触发——拿不到互斥行，保持 pending
    const rtB = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      leaseTtlMs: 200,
    });
    rtB.start();
    let businessWrites = 0;
    rtB.registerHandler("daily-claims-risk", async ({ trigger, session, effects }) =>
      effects.runEffect("check", async () => {
        businessWrites += 1;
        await session.query(
          "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
          { key: trigger.idempotencyKey },
        );
        return { ok: true };
      }),
    );
    const blocked = await rtB.enqueue(delivery("k-window-b"));
    expect(blocked.outcome).toBe("coalesced");
    expect(businessWrites).toBe(0);
    const rows0 = await triggerRows(fixture);
    const rowB = rows0.find((r) => r.idempotency_key === "k-window-b")!;
    expect(rowB.status).toBe("pending");

    // A 死透、窗口租约到期（root 拨快时钟模拟）：B 重投递接管互斥行并完成
    await fixture.root.query("UPDATE employee_window SET lease_expires_at = time::now() - 1s;");
    const ok = await rtB.enqueue(delivery("k-window-b"));
    expect(ok.outcome).toBe("completed");
    expect(businessWrites).toBe(1);

    // A 的触发停在 running（死窗口挂在 handler 里）；B 完成。
    const rows = await triggerRows(fixture);
    const rowA = rows.find((r) => r.idempotency_key === "k-window-a")!;
    const rowB2 = rows.find((r) => r.idempotency_key === "k-window-b")!;
    expect(rowA.status).toBe("running");
    expect(rowB2.status).toBe("completed");
    // rtA 的窗口链被挂起的 handler 占着——stop 等不到排空，只停闸不等待。
    void rtA.stop();
    await rtB.stop();
    await employeeRuntime.stop();
  }, 90_000);
});
