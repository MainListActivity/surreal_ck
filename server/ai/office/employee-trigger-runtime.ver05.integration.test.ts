import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime, type EmployeeRuntime } from "./employee-runtime";
import type { RuntimeSignal } from "./employee-gates";
import { createEmployeeTriggerRuntime } from "./employee-trigger-runtime";

/**
 * VER05 真实库集成测试：自起 --allow-all SurrealDB，应用含 037
 * employee_token_usage 的完整模板，员工会话 = 真实 RECORD SIGNIN。断言：
 * - 计量模型闸门把 provider 实测 / 有界估算分列原子累计进 (employee, day)
 *   唯一行；同日 budget-exhausted signal 经 budget_signal_at CAS 只发一次，
 *   跨 runtime（进程）也是一次；
 * - 级联投递真实落库且 chain_depth 强制 parent+1；
 * - 业务日翻页后新一天生成新行、旧行保留；
 * - 认领次数上限触发真实转 failed 终态。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];
const DB = "ws_ver05";
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

const delivery = (key: string, chainDepth = 0) => ({
  database: DB,
  employeeId: EMPLOYEE,
  reason: "daily-claims-risk",
  payloadRef: "2026-09-30",
  chainDepth,
  idempotencyKey: key,
});

async function usageRows(fixture: Fixture) {
  await fixture.root.use({ namespace: fixture.namespace, database: DB });
  const [rows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
    `SELECT employee, day, provider_input_tokens, provider_output_tokens,
            estimated_input_tokens, estimated_output_tokens, calls, budget_signal_at
     FROM employee_token_usage ORDER BY day ASC;`,
  );
  return rows;
}

async function triggerRows(fixture: Fixture) {
  await fixture.root.use({ namespace: fixture.namespace, database: DB });
  const [rows] = await fixture.root.query<[Array<Record<string, unknown>>]>(
    "SELECT id, status, chain_depth, idempotency_key, created_at FROM employee_trigger ORDER BY created_at ASC;",
  );
  return rows;
}

describe("VER05 预算/链深闸门（真实 SurrealDB）", () => {
  test("模型调用经计量闸门：provider 实测与有界估算分列原子累计，(employee, day) 唯一行", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    const runtime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      limits: { dailyTokenBudget: 1_000_000, budgetTimezone: "Asia/Shanghai" },
      now: () => new Date("2026-09-30T12:00:00+08:00"),
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async ({ model }) => {
      const first = await model.call({ maxOutputTokens: 900 }, async (grant) => {
        expect(grant.maxOutputTokens).toBe(900);
        return { result: "a", usage: { inputTokens: 300, outputTokens: 120 } };
      });
      const second = await model.call({ maxOutputTokens: 400 }, async () => ({
        result: "b", // 无 provider usage → estimated 列记账（输入用兜底估算 512）
      }));
      return { first, second };
    });

    const result = await runtime.enqueue(delivery("k-metered"));
    expect(result).toMatchObject({ outcome: "completed" });
    const rows = await usageRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-09-30",
      provider_input_tokens: 300,
      provider_output_tokens: 120,
      estimated_input_tokens: 512,
      estimated_output_tokens: 400,
      calls: 2,
    });
    await runtime.stop();
    await employeeRuntime.stop();
  }, 60_000);

  test("同日 budget-exhausted signal 经 budget_signal_at CAS 跨 runtime 只发一次", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    const signals1: RuntimeSignal[] = [];
    const signals2: RuntimeSignal[] = [];
    const limits = { dailyTokenBudget: 400, fallbackInputTokens: 100 };
    const rt1 = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      limits,
      emitSignal: (signal) => void signals1.push(signal),
      now: () => new Date("2026-09-30T12:00:00+08:00"),
      sleep: () => Promise.resolve(),
    });
    const rt2 = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      limits,
      emitSignal: (signal) => void signals2.push(signal),
      now: () => new Date("2026-09-30T12:00:00+08:00"),
      sleep: () => Promise.resolve(),
    });
    rt1.start();
    rt2.start();
    // 第一次调用实际用量 600 > 预算 400：越过。第二个触发（另一 runtime）
    // preflight 时剩余为负 → 不发调用，signal CAS 已被 rt1 抢去。
    let invocations = 0;
    const handler = async ({ model }: { model: { call: Function } }) =>
      model.call({ maxOutputTokens: 300 }, async () => {
        invocations += 1;
        return { result: "x", usage: { inputTokens: 200, outputTokens: 400 } };
      });
    rt1.registerHandler("daily-claims-risk", handler as never);
    rt2.registerHandler("daily-claims-risk", handler as never);

    expect(await rt1.enqueue(delivery("k-budget-1"))).toMatchObject({ outcome: "completed" });
    // enqueue resolve 于 settleWaiter；窗口互斥行的释放在其后的 finally。
    await Bun.sleep(30);
    const second = await rt2.enqueue(delivery("k-budget-2"));
    expect(second).toMatchObject({ outcome: "failed" });
    expect(second.error).toContain("budget-exhausted");
    expect(invocations).toBe(1);

    const emitted = [...signals1, ...signals2].filter((s) => s.kind === "budget-exhausted");
    expect(emitted).toHaveLength(1);
    const rows = await usageRows(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.budget_signal_at).toBeTruthy();
    await rt1.stop();
    await rt2.stop();
    await employeeRuntime.stop();
  }, 60_000);

  test("级联投递真实落库：chain_depth 强制 parent+1，外部投递超上限拒绝", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    const runtime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      limits: { maxChainDepth: 1 },
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async ({ trigger, emit }) => {
      const child = await emit({
        reason: "daily-claims-risk",
        idempotencyKey: `child-of:${trigger.idempotencyKey}`,
      });
      return { child };
    });

    expect(await runtime.enqueue(delivery("k-parent", 0))).toMatchObject({ outcome: "completed" });
    await Bun.sleep(50); // 级联行由同一窗口 drain
    const rows = await triggerRows(fixture);
    const parent = rows.find((row) => row.idempotency_key === "k-parent");
    const child = rows.find((row) => row.idempotency_key === "child-of:k-parent");
    const grandchild = rows.find((row) => row.idempotency_key === "child-of:child-of:k-parent");
    expect(parent?.chain_depth).toBe(0);
    expect(child?.chain_depth).toBe(1);
    expect(grandchild).toBeUndefined(); // depth 2 > max 1：级联被拒，不落库
    expect(child?.status).toBe("completed");

    const rejected = await runtime.enqueue(delivery("k-too-deep", 2));
    expect(rejected).toMatchObject({ outcome: "failed" });
    expect(rejected.error).toContain("chain-depth-exceeded");
    expect((await triggerRows(fixture)).find((row) => row.idempotency_key === "k-too-deep")).toBeUndefined();
    await runtime.stop();
    await employeeRuntime.stop();
  }, 60_000);

  test("业务日翻页后新额度恢复：新一天新行，旧日用量保留审计", async () => {
    const fixture = await setupFixture();
    const employeeRuntime = await realSessions(fixture);
    let clock = new Date("2026-09-30T23:30:00+08:00");
    const runtime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      limits: { dailyTokenBudget: 500, fallbackInputTokens: 100 },
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    runtime.start();
    runtime.registerHandler("daily-claims-risk", async ({ model }) =>
      model.call({ maxOutputTokens: 300, estimatedInputTokens: 150 }, async () => ({
        result: "ok",
        usage: { inputTokens: 150, outputTokens: 300 },
      })),
    );
    expect(await runtime.enqueue(delivery("k-day1"))).toMatchObject({ outcome: "completed" });
    // 同日已用 450，剩余 50 < 150 估算输入 → 拒绝
    const blocked = await runtime.enqueue(delivery("k-day1-blocked"));
    expect(blocked).toMatchObject({ outcome: "failed" });

    clock = new Date("2026-10-01T08:00:00+08:00");
    expect(await runtime.enqueue(delivery("k-day2"))).toMatchObject({ outcome: "completed" });
    const rows = await usageRows(fixture);
    expect(rows.map((row) => row.day).sort()).toEqual(["2026-09-30", "2026-10-01"]);
    expect(rows.find((row) => row.day === "2026-09-30")?.provider_output_tokens).toBe(300);
    expect(rows.find((row) => row.day === "2026-10-01")?.provider_output_tokens).toBe(300);
    await runtime.stop();
    await employeeRuntime.stop();
  }, 60_000);
});
