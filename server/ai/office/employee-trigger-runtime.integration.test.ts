import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeRuntime } from "./employee-runtime";
import { createEmployeeTriggerRuntime } from "./employee-trigger-runtime";

/**
 * VER03 真实库集成测试：自起 --allow-all SurrealDB，向两个 workspace database
 * 完整应用 workspace template，验证通用持久化触发 runtime：
 * - 投递先持久化到 employee_trigger（幂等键唯一），再由 employee RECORD 会话执行；
 * - 同 workspace 同键重复投递只产生一次副作用（trigger_effect 仅一行）；
 * - 两个 workspace 的员工各自 SIGNIN 各自 db，数据与身份归因严格隔离；
 * - root 会话只读 employee_credential，业务写全部经员工会话；
 * - stop 之后拒绝新投递。
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
  databases: string[];
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
  const databases = ["ws_trigger_a", "ws_trigger_b"];
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
    for (const database of databases) {
      await root.query(`USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database};`).collect();
      await root.use({ namespace, database });
      for (const script of scripts) await root.query(script.sql).collect();
      // 每个 workspace 一名专用风险员工 + 凭证，及一张只验证归因的副作用表。
      await root.query(`
        CREATE user:claims_risk_reminder CONTENT {
          email: "claims-risk-reminder@virtual.local", subject: "claims-risk-reminder",
          kind: "virtual", is_admin: false, display_name: "债权风险提醒专员",
          virtual_profile: { status: "active", role_key: "claims-risk-reminder" }
        };
        INSERT INTO employee_credential {
          employee: user:claims_risk_reminder, secret: "risk-pass-${database}", created_at: time::now()
        };
        DEFINE TABLE trigger_effect SCHEMALESS PERMISSIONS
          FOR select, create WHERE $auth != NONE;
      `).collect();
    }
    fixtureCleanup.push(() => { proc.kill(); });
    return { url, namespace, password, root, databases };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
}

describe("employee trigger runtime against real SurrealDB", () => {
  test("持久化触发→员工会话执行→幂等收敛→跨 workspace 隔离→关停拒收", async () => {
    const fixture = await setupFixture();
    const rootQueries: string[] = [];
    const runtime = createEmployeeRuntime({
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
      // root 会话只该碰 employee_credential：把每条 root 查询记下来断言。
      rootSession: async (database) => {
        const session = new Surreal();
        opened.push(session);
        await session.connect(fixture.url);
        await session.signin({ username: "test", password: fixture.password });
        await session.use({ namespace: fixture.namespace, database });
        return {
          query(sql: string, params?: Record<string, unknown>) {
            rootQueries.push(sql);
            return session.query(sql, params);
          },
        };
      },
    });

    const triggerRuntime = createEmployeeTriggerRuntime({
      sessions: runtime,
      driver: createMastraEmployeeDriver,
    });
    const effects: Array<{ database: string; key: string }> = [];
    triggerRuntime.registerHandler("daily-claims-risk", async ({ trigger, session }) => {
      effects.push({ database: trigger.database, key: trigger.idempotencyKey });
      await session.query(
        "CREATE trigger_effect CONTENT { effect_key: $key, actor: $auth.id };",
        { key: trigger.idempotencyKey },
      );
      return { remindersCreated: 1 };
    });
    triggerRuntime.start();

    const [dbA, dbB] = fixture.databases;
    const delivery = (database: string, key: string) => ({
      database,
      employeeId: "user:claims_risk_reminder",
      reason: "daily-claims-risk",
      payloadRef: "2026-09-30",
      chainDepth: 0,
      idempotencyKey: key,
    });

    const first = await triggerRuntime.enqueue(delivery(dbA, "daily-claims-risk:user:claims_risk_reminder:2026-09-30"));
    expect(first.outcome).toBe("completed");
    // 窗口结束后员工会话已关闭
    expect(runtime.session(dbA, "user:claims_risk_reminder")).toBeUndefined();

    // 同 workspace 同键重复投递：只产生一次副作用
    const second = await triggerRuntime.enqueue(delivery(dbA, "daily-claims-risk:user:claims_risk_reminder:2026-09-30"));
    expect(second.outcome).toBe("coalesced");

    // 第二个 workspace：同键互不干扰（db 边界隔离）
    const other = await triggerRuntime.enqueue(delivery(dbB, "daily-claims-risk:user:claims_risk_reminder:2026-09-30"));
    expect(other.outcome).toBe("completed");

    expect(effects).toHaveLength(2);

    // 触发记录按 db 隔离，且归因到各 db 的员工
    for (const database of fixture.databases) {
      await fixture.root.use({ namespace: fixture.namespace, database });
      const [triggers] = await fixture.root.query<[
        Array<{ status: string; employee: unknown; reason: string; payload_ref: string }>,
      ]>("SELECT status, employee, reason, payload_ref FROM employee_trigger;");
      expect(triggers).toHaveLength(1);
      expect(triggers[0]).toMatchObject({
        status: "completed",
        reason: "daily-claims-risk",
        payload_ref: "2026-09-30",
      });
      expect(String(triggers[0]?.employee)).toBe("user:claims_risk_reminder");
      const [effectRows] = await fixture.root.query<[
        Array<{ effect_key: string; actor: unknown }>,
      ]>("SELECT effect_key, actor FROM trigger_effect;");
      expect(effectRows).toHaveLength(1);
      expect(String(effectRows[0]?.actor)).toBe("user:claims_risk_reminder");
    }

    // root 的使用面：只允许 employee_credential 凭证读取，业务写全在员工会话
    expect(rootQueries.length).toBeGreaterThan(0);
    for (const sql of rootQueries) {
      expect(sql).toContain("employee_credential");
    }

    // stop 之后拒绝新投递
    await triggerRuntime.stop();
    await expect(
      triggerRuntime.enqueue(delivery(dbA, "daily-claims-risk:user:claims_risk_reminder:2026-10-01")),
    ).rejects.toThrow("employee-trigger-runtime-stopped");
    await runtime.stop();
  }, 60_000);
});
