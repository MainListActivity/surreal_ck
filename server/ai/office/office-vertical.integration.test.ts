import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { homedir } from "node:os";
import { createEmployeeLifecycle } from "./employee-lifecycle";
import { createEmployeeRuntime, type EmployeeRuntime } from "./employee-runtime";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeTriggerRuntime, type EmployeeTriggerRuntime } from "./employee-trigger-runtime";
import {
  bootstrapOffice,
  notifyOfficeTask,
  officeManagerEmployeeId,
  reconcileOfficeWorkspace,
  type OfficeBootstrapResult,
} from "./office-trigger-adapter";
import {
  OFFICE_BOOTSTRAP_REASON,
  registerProjectManagerHandlers,
} from "./project-manager";

/**
 * VO02 真实 SurrealDB 纵切：管理员写 goal/primary_contact → bootstrap 幂等开岗
 * 项目经理 → PM 在自身 employee 会话里创建初始任务、发可见进度、向 primary
 * contact 交付持久报告。断言：
 * - 重试同一 bootstrap 收敛到一个员工、一个初始任务、一份报告；
 * - 新任务经 adapter（office-task 触发）驱动，定期 reconciliation 可补投；
 * - 委派超深 / 派给不存在或暂停员工 / 尝试 DDL 都被领域或数据库边界拒绝，
 *   并以可见 office_message + 报告 blocked_by 形成可诊断结果；
 * - root 不参与业务写：office_* 行的 author/assigner 全部是员工自身。
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
  database: string;
  issuer: string;
  privateKey: CryptoKey;
  root: Surreal;
};

async function setupFixture(database: string): Promise<Fixture> {
  const port = 23000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }),
  });
  const issuer = `http://127.0.0.1:${jwks.port}`;
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
    for (const script of await loadTemplateScripts({ oidcJwksUrl: `${issuer}/jwks` })) {
      await root.query(script.sql).collect();
    }
    // 预建真人账号绕开 admin AUTHENTICATE 首次建用户的已知边角（见 VER02 测试）。
    await root.query(`
      CREATE user:owner CONTENT {
        subject: "owner-sub", email: "owner@example.test", display_name: "Owner",
        kind: "human", is_admin: true
      };
      CREATE user:member CONTENT {
        subject: "member-sub", email: "member@example.test", display_name: "Member",
        kind: "human", is_admin: false
      };
    `).collect();
    fixtureCleanup.push(() => { proc.kill(); jwks.stop(true); });
    return { url, namespace, database, issuer, privateKey: keys.privateKey, root };
  } catch (cause) {
    proc.kill();
    jwks.stop(true);
    throw cause;
  }
}

async function jwtSession(
  fixture: Fixture,
  input: { sub: string; ac: "admin" | "participant" },
): Promise<Surreal> {
  const claims: Record<string, unknown> = {
    ns: fixture.namespace,
    db: fixture.database,
    ac: input.ac,
    email: `${input.sub}@example.test`,
  };
  if (input.ac === "admin") claims.RL = ["Owner"];
  const token = await new SignJWT(claims)
    .setSubject(input.sub)
    .setIssuer(fixture.issuer)
    .setExpirationTime("120s")
    .setIssuedAt()
    .setProtectedHeader({ alg: "ES256", kid: "fixture" })
    .sign(fixture.privateKey);
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url);
  await db.authenticate(token);
  return db;
}

type Stack = {
  employeeRuntime: EmployeeRuntime;
  triggerRuntime: EmployeeTriggerRuntime;
  bootstrap: (input: { slug: string; callerToken: string }) => Promise<OfficeBootstrapResult>;
};

function buildStack(fixture: Fixture): Stack {
  const employeeRuntime = createEmployeeRuntime({
    surrealUrl: fixture.url,
    namespace: fixture.namespace,
    rootSession: async () => ({
      query: (sql: string, params?: Record<string, unknown>) =>
        fixture.root.query(sql, params),
    }),
  });
  const lifecycle = createEmployeeLifecycle({
    resolveWorkspace: async () => ({ dbName: fixture.database }),
    callerSession: (_db, token) => jwtSession(fixture, { sub: token, ac: "admin" }),
    rootSession: async () => ({
      query: (sql: string, params?: Record<string, unknown>) =>
        fixture.root.query(sql, params),
    }),
    runtime: employeeRuntime,
  });
  const triggerRuntime = createEmployeeTriggerRuntime({
    sessions: employeeRuntime,
    driver: createMastraEmployeeDriver,
    sleep: () => Promise.resolve(),
  });
  registerProjectManagerHandlers(triggerRuntime);
  triggerRuntime.start();
  return {
    employeeRuntime,
    triggerRuntime,
    bootstrap: (input) =>
      bootstrapOffice(
        {
          lifecycle,
          triggerRuntime,
          resolveWorkspace: async () => ({ dbName: fixture.database }),
          callerSession: (_db, token) => jwtSession(fixture, { sub: token, ac: "admin" }),
        },
        input,
      ),
  };
}

async function rows<T>(fixture: Fixture, sql: string, params?: Record<string, unknown>): Promise<T[]> {
  await fixture.root.use({ namespace: fixture.namespace, database: fixture.database });
  const [result] = await fixture.root.query<[T[]]>(sql, params);
  return result ?? [];
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last != null && last !== false) return last;
    await Bun.sleep(100);
  }
  throw new Error("waitFor 超时：" + JSON.stringify(last));
}

describe("VO02 项目经理纵切（真实 SurrealDB）", () => {
  test("goal → bootstrap → 初始任务 → 进度 → 报告；重试与重放零重复", async () => {
    const fixture = await setupFixture("ws_vo02_main");
    const stack = buildStack(fixture);
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    await admin.query(
      `CREATE office_meta:office CONTENT {
        goal: "把债权台账跑出风险清单",
        primary_contact: user:member,
        state: "onboarding"
      };`,
    ).collect();

    const first = await stack.bootstrap({ slug: "acme", callerToken: "owner-sub" });
    expect(first).toMatchObject({
      kind: "ok",
      employeeId: officeManagerEmployeeId(fixture.database),
      outcome: "completed",
      taskId: "office_task:pm_initial",
    });
    const pmId = officeManagerEmployeeId(fixture.database);

    // 初始任务终态 = done（级联 office-task 在同一 lane 内 drain）。
    const task = await waitFor(async () => {
      const [t] = await rows<Record<string, unknown>>(fixture,
        "SELECT * FROM office_task:pm_initial");
      return t && (t as { status?: unknown }).status === "done" ? t : null;
    });
    expect(task).toMatchObject({
      goal: "把债权台账跑出风险清单",
      depth: 0,
      status: "done",
    });
    expect(String(task.id)).toBe("office_task:pm_initial");
    expect(String(task.assigner)).toBe(pmId);
    expect(String(task.assignee)).toBe(pmId);
    expect(task.completion).toContain("交付");
    expect(task.parent ?? null).toBeNull();

    // 可见进度（至少一条）+ 持久报告，全部归因到 PM 自身。
    const messages = await rows<Record<string, unknown>>(fixture,
      "SELECT id, author, task, body, created_at FROM office_message ORDER BY created_at");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) expect(String(m.author)).toBe(pmId);

    const reports = await rows<Record<string, unknown>>(fixture,
      "SELECT id, author, task, to, summary FROM office_report");
    expect(reports).toHaveLength(1);
    expect(String(reports[0]!.id)).toBe("office_report:pm_report_office_task_pm_initial");
    expect(String(reports[0]!.author)).toBe(pmId);
    expect(String(reports[0]!.task)).toBe("office_task:pm_initial");
    expect(String(reports[0]!.to)).toBe("user:member");

    // primary contact（participant RECORD 会话）能读到报告。
    const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
    const [visible] = await member.query<unknown[]>(
      "SELECT id FROM office_report:pm_report_office_task_pm_initial;",
    ).collect();
    expect(visible).toHaveLength(1);
    await member.close();

    // 员工实例恰好一个（幂等）。
    const virtualUsers = await rows<{ id: unknown }>(fixture,
      'SELECT id FROM user WHERE kind = "virtual"');
    expect(virtualUsers).toHaveLength(1);
    expect(String(virtualUsers[0]!.id)).toBe(pmId);

    // 重试 bootstrap：同一员工、同一触发收敛 coalesced，无重复任务/报告。
    const retry = await stack.bootstrap({ slug: "acme", callerToken: "owner-sub" });
    expect(retry).toMatchObject({ kind: "ok", employeeId: pmId, outcome: "coalesced" });
    await Bun.sleep(150);
    expect(await rows(fixture, "SELECT id FROM office_task")).toHaveLength(1);
    expect(await rows(fixture, "SELECT id FROM office_report")).toHaveLength(1);

    // 直接重放同一触发键 → coalesced；重复 notifyOfficeTask 同键 → coalesced。
    const replay = await stack.triggerRuntime.enqueue({
      database: fixture.database,
      employeeId: pmId,
      reason: OFFICE_BOOTSTRAP_REASON,
      payloadRef: "office_meta:office",
      idempotencyKey: "office-bootstrap",
    });
    expect(replay.outcome).toBe("coalesced");
    const dupTask = await notifyOfficeTask(stack.triggerRuntime, {
      database: fixture.database,
      assigneeId: pmId,
      taskId: "office_task:pm_initial",
    });
    expect(dupTask.outcome).toBe("coalesced");
    await Bun.sleep(150);
    expect(await rows(fixture, "SELECT id FROM office_report")).toHaveLength(1);

    // office_meta 被推进到 active。
    const [meta] = await rows<Record<string, unknown>>(fixture,
      "SELECT state FROM office_meta:office");
    expect(meta?.state).toBe("active");

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 90_000);

  test("office_meta 未就绪时 bootstrap 拒绝且不消耗触发键", async () => {
    const fixture = await setupFixture("ws_vo02_noMeta");
    const stack = buildStack(fixture);

    const missing = await stack.bootstrap({ slug: "acme", callerToken: "owner-sub" });
    expect(missing.kind).toBe("meta-incomplete");
    expect(await rows(fixture, "SELECT id FROM employee_trigger")).toHaveLength(0);
    expect(await rows(fixture, 'SELECT id FROM user WHERE kind = "virtual"')).toHaveLength(0);

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 90_000);

  test("委派超深 / 暂停或不存在 assignee / DDL 尝试都被拒并留可诊断记录", async () => {
    const fixture = await setupFixture("ws_vo02_bounds");
    const stack = buildStack(fixture);
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    await admin.query(
      `CREATE office_meta:office CONTENT {
        goal: "边界诊断", primary_contact: user:member, state: "onboarding"
      };`,
    ).collect();
    expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub" })).kind).toBe("ok");
    const pmId = officeManagerEmployeeId(fixture.database);

    // 等初始任务做完，避免触发串行影响后续断言时序。
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:pm_initial");
      return t?.status === "done" ? t : null;
    });

    // 不存在/暂停 assignee + DDL：三个任务由 admin 直接建（模拟浏览器写入），
    // 经 adapter 投递给 PM，PM 在 handler 里尝试后被领域/DB 边界拒绝。
    await admin.query(`
      CREATE user:paused CONTENT {
        subject: "paused-sub", email: "p@virtual.local", kind: "virtual",
        is_admin: false, virtual_profile: { status: "paused" }
      };
      CREATE office_task:t_paused CONTENT {
        goal: "派给暂停员工", assignee: ${pmId},
        brief: { delegate_to: "user:paused", delegate_goal: "做一半" }
      };
      CREATE office_task:t_ghost CONTENT {
        goal: "派给不存在员工", assignee: ${pmId},
        brief: { delegate_to: "user:ghost", delegate_goal: "查无此人" }
      };
      CREATE office_task:t_ddl CONTENT {
        goal: "尝试直接改库结构", assignee: ${pmId},
        brief: { attempt_ddl: "DEFINE TABLE hacked SCHEMAFULL" }
      };
    `).collect();

    for (const id of ["office_task:t_paused", "office_task:t_ghost", "office_task:t_ddl"]) {
      const r = await notifyOfficeTask(stack.triggerRuntime, {
        database: fixture.database, assigneeId: pmId, taskId: id,
      });
      expect(r.outcome).toBe("completed");
    }

    const allMessages = await rows<{ id: unknown; body: string }>(fixture,
      "SELECT id, body FROM office_message");
    const messages = allMessages.filter((m) => String(m.id).includes("pm_reject_"));
    const kinds = messages.map((m) => String(m.id)).sort();
    expect(kinds).toEqual(expect.arrayContaining([
      expect.stringContaining("pm_reject_delegation_office_task_t_ghost"),
      expect.stringContaining("pm_reject_delegation_office_task_t_paused"),
      expect.stringContaining("pm_reject_ddl_office_task_t_ddl"),
    ]));
    const bodies = messages.map((m) => m.body).join("\n");
    expect(bodies).toContain("assignee-not-found");
    expect(bodies).toContain("assignee-inactive");

    // 三张任务都走完（done）且各有一份诊断报告（blocked_by 非空）。
    const reportRows = await rows<{ id: string; blocked_by?: unknown }>(fixture,
      "SELECT id, blocked_by FROM office_report WHERE id != office_report:pm_report_office_task_pm_initial ORDER BY id");
    expect(reportRows).toHaveLength(3);
    for (const r of reportRows) expect(r.blocked_by).toBeTruthy();
    const taskStates = await rows<{ id: string; status: string }>(fixture,
      "SELECT id, status FROM office_task WHERE id INSIDE [office_task:t_paused, office_task:t_ghost, office_task:t_ddl]");
    for (const t of taskStates) expect(t.status).toBe("done");
    // 恶意 DDL 未落库。
    const [tables] = await fixture.root.query<[{ tables?: Record<string, unknown> }]>(
      "INFO FOR DB;",
    );
    expect(Object.keys(tables?.[0]?.tables ?? {})).not.toContain("hacked");

    // 委派超深：admin 建到 depth 8 的链，让 PM 对末梢再派单。
    await admin.query(`CREATE office_task:chain_0 CONTENT { goal: "链0", assignee: ${pmId} };`).collect();
    for (let i = 1; i <= 8; i += 1) {
      await admin.query(
        `CREATE office_task:chain_${i} CONTENT {
          goal: "链${i}", assignee: ${pmId},
          parent: office_task:chain_${i - 1}, depth: ${i},
          brief: ${i === 8 ? `{ delegate_to: "${pmId}", delegate_goal: "再往下派" }` : "NONE"}
        };`,
      ).collect();
    }
    const deep = await notifyOfficeTask(stack.triggerRuntime, {
      database: fixture.database, assigneeId: pmId, taskId: "office_task:chain_8",
    });
    expect(deep.outcome).toBe("completed");
    const depthMsg = await rows<{ body: string }>(fixture,
      "SELECT body FROM office_message:pm_reject_delegation_office_task_chain_8");
    expect(depthMsg).toHaveLength(1);
    expect(depthMsg[0]!.body).toContain("delegation-depth-exceeded");

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 120_000);

  test("定期 reconciliation 补投未被通知的任务", async () => {
    const fixture = await setupFixture("ws_vo02_reconcile");
    const stack = buildStack(fixture);
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    await admin.query(
      `CREATE office_meta:office CONTENT {
        goal: "reconcile 补投", primary_contact: user:member, state: "onboarding"
      };`,
    ).collect();
    expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub" })).kind).toBe("ok");
    const pmId = officeManagerEmployeeId(fixture.database);
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:pm_initial");
      return t?.status === "done" ? t : null;
    });

    // 模拟一次"浏览器写入但事件丢失"：admin 直接建任务，不走任何投递。
    await admin.query(
      `CREATE office_task:manual_lost CONTENT {
        goal: "未被通知的任务", assignee: ${pmId},
        completion: "交付补投报告"
      };`,
    ).collect();

    const summary = await reconcileOfficeWorkspace({
      runtime: stack.triggerRuntime,
      root: {
        query: (sql: string, params?: Record<string, unknown>) =>
          fixture.root.query(sql, params),
      },
      database: fixture.database,
    });
    expect(summary.employees).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched + summary.coalesced).toBeGreaterThanOrEqual(1);

    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:manual_lost");
      return t?.status === "done" ? t : null;
    });
    const [report] = await rows<{ id: unknown }>(fixture,
      "SELECT id FROM office_report:pm_report_office_task_manual_lost");
    expect(String(report!.id)).toBe("office_report:pm_report_office_task_manual_lost");

    // 再跑一次 reconcile：全部收敛为 coalesced，无重复副作用。
    const again = await reconcileOfficeWorkspace({
      runtime: stack.triggerRuntime,
      root: {
        query: (sql: string, params?: Record<string, unknown>) =>
          fixture.root.query(sql, params),
      },
      database: fixture.database,
    });
    expect(again.failed).toBe(0);
    expect(await rows(fixture, "SELECT id FROM office_report")).toHaveLength(2);

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 120_000);
});
