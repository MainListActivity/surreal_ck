import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import { createEmployeeRuntime } from "./employee-runtime";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeTriggerRuntime } from "./employee-trigger-runtime";
import { QA_PROBE_REASON, registerQaProbeHandler } from "./qa-probe";

/**
 * qa-probe 投递口 runtime 级验证（真实 SurrealDB）：
 * - active 夹具员工：enqueue → 真实 SIGNIN → 窗口 → durable run → effect 账本
 *   全部真实落地，outcome=completed，结果只含确定性 probe 摘要；
 * - 暂停夹具员工：SIGNIN 被 employee access 拒绝 → outcome=failed 且
 *   employee_trigger / employee_effect 零新增（投递面"不落库"契约）；
 * - 同幂等键重放 → coalesced，账本不重复。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});

async function setupFixture(database: string) {
  const port = 23000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const namespace = "main";
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
    await root.query(
      `DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database}; USE DB ${database};`,
    ).collect();
    await root.use({ namespace, database });
    for (const script of await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:1/jwks" })) {
      await root.query(script.sql).collect();
    }
    fixtureCleanup.push(() => proc.kill());
    return { url, namespace, database, root };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
}

/** root 直建夹具员工 + 凭证（与 ensureClaimsRiskEmployee 同形，生产不走这条）。 */
async function seedEmployee(
  root: Surreal,
  employeeId: string,
  status: "active" | "paused",
): Promise<void> {
  await root.query(
    `CREATE ${employeeId} CONTENT {
      email: "${employeeId.replace("user:", "")}@virtual.local",
      subject: "${employeeId.replace("user:", "")}-subject",
      kind: "virtual", is_admin: false,
      display_name: "QA 夹具员工",
      virtual_profile: { status: "${status}" }
    };
    INSERT INTO employee_credential { employee: ${employeeId}, secret: $secret, created_at: time::now() };`,
    { secret: `secret-${crypto.randomUUID()}` },
  ).collect();
}

describe("qa-probe 投递链路（真实 SurrealDB）", () => {
  test("active 员工投递 → completed + effect 账本；暂停员工 → failed 且不落库；同键重放 coalesced", async () => {
    const fixture = await setupFixture("ws_qaprobe");
    await seedEmployee(fixture.root, "user:qa_probe_active", "active");
    await seedEmployee(fixture.root, "user:qa_probe_paused", "paused");

    const employeeRuntime = createEmployeeRuntime({
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
      rootSession: async () => ({
        query: (sql: string, params?: Record<string, unknown>) => fixture.root.query(sql, params),
      }),
    });
    const triggerRuntime = createEmployeeTriggerRuntime({
      sessions: employeeRuntime,
      driver: createMastraEmployeeDriver,
      sleep: () => Promise.resolve(),
    });
    registerQaProbeHandler(triggerRuntime);
    triggerRuntime.start();

    // ── active：真实 SIGNIN → durable run → runEffect 账本 ──────────────
    const first = await triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: "user:qa_probe_active",
      reason: QA_PROBE_REASON,
      payloadRef: "qa:evidence:1",
      chainDepth: 0,
      idempotencyKey: "qa-probe-accept-1",
    });
    expect(first.outcome).toBe("completed");
    expect(first.triggerId).toBeTruthy();

    // 触发持久化行存在且终态 completed；结果不带 Surreal 行/会话对象。
    const [triggerRows] = await fixture.root.query<[[Record<string, unknown>]]>(
      "SELECT * FROM employee_trigger WHERE idempotency_key = 'qa-probe-accept-1';",
    );
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0].status).toBe("completed");
    expect(JSON.stringify(triggerRows[0].result)).toContain('"probe":true');
    expect(JSON.stringify(triggerRows[0].result)).toContain('"payloadRef":"qa:evidence:1"');

    const [effects] = await fixture.root.query<[[Record<string, unknown>]]>(
      "SELECT * FROM employee_effect WHERE trigger = $t;",
      { t: (triggerRows[0] as { id: unknown }).id },
    );
    expect(effects).toHaveLength(1);
    expect((effects[0] as { status?: unknown }).status).toBe("committed");

    // 同幂等键重放 → coalesced，无第二行。
    const replay = await triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: "user:qa_probe_active",
      reason: QA_PROBE_REASON,
      chainDepth: 0,
      idempotencyKey: "qa-probe-accept-1",
    });
    expect(replay.outcome).toBe("coalesced");
    const [allTriggers] = await fixture.root.query<[[{ id: unknown }]]>(
      "SELECT id FROM employee_trigger;",
    );
    expect(allTriggers).toHaveLength(1);

    // ── paused：SIGNIN 被 access 拒 → failed，触发/账本零新增 ─────────────
    const denied = await triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: "user:qa_probe_paused",
      reason: QA_PROBE_REASON,
      chainDepth: 0,
      idempotencyKey: "qa-probe-paused-1",
    });
    expect(denied.outcome).toBe("failed");
    expect(denied.triggerId).toBeUndefined();

    const [afterDenied] = await fixture.root.query<[[{ id: unknown }]]>(
      "SELECT id FROM employee_trigger;",
    );
    expect(afterDenied).toHaveLength(1);
    const [effectsAfter] = await fixture.root.query<[[{ id: unknown }]]>(
      "SELECT id FROM employee_effect;",
    );
    expect(effectsAfter).toHaveLength(1);

    // 不存在/无凭证员工同样 failed 不落库。
    const missing = await triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: "user:qa_probe_ghost",
      reason: QA_PROBE_REASON,
      chainDepth: 0,
      idempotencyKey: "qa-probe-ghost-1",
    });
    expect(missing.outcome).toBe("failed");
    const [final] = await fixture.root.query<[[{ id: unknown }]]>(
      "SELECT id FROM employee_trigger;",
    );
    expect(final).toHaveLength(1);

    await triggerRuntime.stop();
    await employeeRuntime.stop();
  }, 90_000);
});
