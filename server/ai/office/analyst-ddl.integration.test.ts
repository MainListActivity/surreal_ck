import { afterEach, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { homedir } from "node:os";
import { createEmployeeLifecycle } from "./employee-lifecycle";
import { createEmployeeRuntime } from "./employee-runtime";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import { createEmployeeTriggerRuntime, type EmployeeTriggerRuntime } from "./employee-trigger-runtime";
import {
  notifyOfficeTask,
  notifyOfficeRequestResolved,
  reconcileOfficeWorkspace,
  wakeResolvedOfficeRequest,
} from "./office-trigger-adapter";
import { registerProjectManagerHandlers } from "./project-manager";
import { createOfficeTaskOnce } from "./office-domain";
import { proposeOfficeDdl, OFFICE_ANALYST_REQUEST_KEY } from "./data-analyst";
import { normalizeOfficeDdl } from "@surreal-ck/shared/office-ddl";
import { decideOfficeDdl, readOfficeDdl, reconcileOfficeDdl, type DdlConnection } from "@surreal-ck/shared/office-ddl-execution";

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
  const publicKey = await exportSPKI(keys.publicKey);
  const issuer = "https://vo05-fixture.example.test";
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
      // 本地 fork 可能未启用 jwks feature；只替换 fixture 的签名验证来源，
      // 保留生产 admin/participant access 类型、AUTHENTICATE 与真实 ES256 JWT。
      const sql = script.sql.replaceAll(
        `JWT URL "${issuer}/jwks"`,
        `JWT ALGORITHM ES256 KEY ${JSON.stringify(publicKey)}`,
      );
      await root.query(sql).collect();
    }
    await root.query(`
      CREATE user:owner CONTENT {
        subject: "owner-sub", email: "owner@example.test", display_name: "Owner",
        kind: "human", is_admin: true
      };
      CREATE user:member CONTENT {
        subject: "member-sub", email: "member@example.test", display_name: "Member",
        kind: "human", is_admin: false
      };
      CREATE user:other CONTENT {
        subject: "other-sub", email: "other@example.test", display_name: "Other",
        kind: "human", is_admin: false
      };
    `).collect();
    fixtureCleanup.push(() => { proc.kill(); });
    return { url, namespace, database, issuer, privateKey: keys.privateKey, root };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
}

type SessionOptions = {
  /** 注入的底层驱动选项——测试用 websocketImpl 获得真实断线原语。 */
  driver?: ConstructorParameters<typeof Surreal>[0];
  /** connect() 选项——重连测试用更短的重试间隔。 */
  connect?: Parameters<Surreal["connect"]>[1];
};

async function jwtSession(
  fixture: Fixture,
  input: { sub: string; ac: "admin" | "participant" },
  options: SessionOptions = {},
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
  const db = new Surreal(options.driver);
  opened.push(db);
  await db.connect(fixture.url, options.connect);
  await db.authenticate(token);
  return db;
}

async function employeeSession(fixture: Fixture, employeeId: string): Promise<Surreal> {
  const [[credential]] = await fixture.root.query<[{ secret: string; subject: string }[]]>(
    "SELECT secret, employee.subject AS subject FROM employee_credential WHERE employee = $employee",
    { employee: new StringRecordId(employeeId) });
  if (!credential) throw new Error("fixture employee missing");
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url);
  await db.signin({ namespace: fixture.namespace, database: fixture.database, access: "employee",
    variables: { subject: credential.subject, pass: credential.secret } });
  return db;
}

function browser(conn: Surreal): DdlConnection {
  return {
    async query<T>(sql: string, bindings?: Record<string, unknown>): Promise<T[]> {
      const [rows] = await conn.query<[T[]]>(sql, bindings).collect();
      return rows ?? [];
    },
    async transaction<T>(run: (tx: DdlConnection) => Promise<T>): Promise<T> {
      const tx = await conn.beginTransaction();
      try {
        const result = await run({
          async query<R>(sql: string, bindings?: Record<string, unknown>): Promise<R[]> {
            const [rows] = await tx.query<[R[]]>(sql, bindings).collect();
            return rows ?? [];
          },
          transaction: async () => { throw new Error("nested transaction unsupported"); },
        });
        await tx.commit();
        return result;
      } catch (cause) { await tx.cancel().catch(() => undefined); throw cause; }
    },
  };
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const result = await read();
    if (result) return result;
    await Bun.sleep(50);
  }
  throw new Error("等待持久状态超时");
}

test("VO05 实际 fork + admin/participant/employee + Mastra：开岗、DDL、拒绝、失败、刷新与恢复", async () => {
  const fixture = await setupFixture("ws_vo05");
  const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
  const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
  const connection = browser(admin);
  let triggerRuntime: EmployeeTriggerRuntime | undefined;
  const employeeRuntime = createEmployeeRuntime({
    surrealUrl: fixture.url, namespace: fixture.namespace,
    rootSession: async () => fixture.root,
    onSessionClosed: (database, employeeId) => triggerRuntime?.invalidateSession({ database, employeeId }),
  });
  const runtime = createEmployeeTriggerRuntime({ sessions: employeeRuntime, driver: createMastraEmployeeDriver,
    sleep: () => Promise.resolve() });
  triggerRuntime = runtime;
  const lifecycle = createEmployeeLifecycle({
    resolveWorkspace: async () => ({ dbName: fixture.database }),
    callerSession: async () => ({ query: admin.query.bind(admin) }),
    rootSession: async () => fixture.root, runtime: employeeRuntime,
  });
  registerProjectManagerHandlers(runtime, {
    provisionAnalyst: async (ctx) => {
      const restricted = createEmployeeLifecycle({
        resolveWorkspace: async () => ({ dbName: fixture.database }),
        callerSession: async () => ctx.session,
        rootSession: async () => fixture.root, runtime: employeeRuntime,
      });
      const result = await restricted.provision({ slug: "acme", callerToken: "",
        roleKey: "data-analyst", requestKey: OFFICE_ANALYST_REQUEST_KEY, supervisor: ctx.trigger.employeeId });
      if (result.kind !== "ok") throw new Error(result.kind);
      return result.employee.id;
    },
  });
  runtime.start();
  try {
    await admin.query(`CREATE office_meta:office CONTENT {
      goal: "分析销售数据", primary_contact: user:owner, state: "onboarding", import_state: "skipped"
    }; DEFINE TABLE ent_sales SCHEMAFULL PERMISSIONS FULL;
    DEFINE FIELD amount ON ent_sales TYPE option<int>;
    CREATE ent_sales:first SET amount = 42;`).collect();
    const manager = await lifecycle.provision({ slug: "acme", callerToken: "fixture",
      roleKey: "project-manager", requestKey: "office-bootstrap:project-manager" });
    if (manager.kind !== "ok") throw new Error(manager.kind);
    const managerId = manager.employee.id;
    let managerSession = await employeeSession(fixture, managerId);
    const task = await createOfficeTaskOnce(managerSession, "office_task:need_analysis", {
      goal: "核对销售数据并提出备注字段", assignee: managerId,
      brief: { analysis: { table: "ent_sales", change: { op: "define_field", table: "ent_sales", field: "note", type: "string" },
        rationale: "记录核验说明", impact: "新增可选备注，不改变已有金额" } },
    });
    expect((await notifyOfficeTask(runtime, { database: fixture.database, assigneeId: managerId, taskId: task.id })).outcome).toBe("completed");
    const intent = await waitFor(async () => {
      const [[row]] = await fixture.root.query<[{ id: unknown }[]]>("SELECT id FROM office_ddl_intent");
      return row ? readOfficeDdl(connection, String(row.id)) : null;
    });
    const analystId = intent.author;
    await waitFor(async () => {
      const [[row]] = await fixture.root.query<[{ status: string }[]]>(
        "SELECT status FROM employee_trigger WHERE employee = $employee AND reason = 'office-task' AND status = 'completed'",
        { employee: new StringRecordId(analystId) });
      return row ?? null;
    });
    let analyst = await employeeSession(fixture, analystId);
    managerSession = await employeeSession(fixture, managerId);
    const again = await createEmployeeLifecycle({
      resolveWorkspace: async () => ({ dbName: fixture.database }), callerSession: async () => managerSession,
      rootSession: async () => fixture.root, runtime: employeeRuntime,
    }).provision({ slug: "acme", callerToken: "", requestKey: OFFICE_ANALYST_REQUEST_KEY,
      roleKey: "data-analyst", supervisor: managerId });
    expect(again).toMatchObject({ kind: "ok", created: false, employee: { id: analystId } });
    analyst = await employeeSession(fixture, analystId);
    managerSession = await employeeSession(fixture, managerId);
    const [[count]] = await fixture.root.query<[{ count: number }[]]>("SELECT count() FROM user WHERE virtual_profile.role_key = 'data-analyst' GROUP ALL");
    expect(count?.count).toBe(1);
    await expect(analyst.query("UPDATE $employee SET is_admin = true", {
      employee: new StringRecordId(analystId) }).collect()).rejects.toThrow(/identity/);
    await expect(managerSession.query("UPDATE $employee SET subject = 'hijacked'", {
      employee: new StringRecordId(analystId) }).collect()).rejects.toThrow(/provisioning/);
    const [secrets] = await analyst.query<[unknown[]]>("SELECT id FROM employee_credential");
    expect(secrets).toHaveLength(0);
    const [human] = await managerSession.query<[unknown[]]>(`CREATE user:forbidden CONTENT {
      email:'forbidden@example.test', kind:'human', is_admin:false } RETURN AFTER`);
    expect(human).toHaveLength(0);
    // 真正的 employee DML；不会借用 admin 执行业务读取或写入。
    await analyst.query("UPDATE ent_sales:first SET amount = 43").collect();
    const [[sale]] = await analyst.query<[{ amount: number }[]]>("SELECT amount FROM ent_sales:first");
    expect(sale?.amount).toBe(43);
    await expect(analyst.query("DEFINE TABLE ent_forbidden").collect()).rejects.toThrow();
    await expect(member.query("DEFINE TABLE ent_forbidden").collect()).rejects.toThrow();
    await expect(decideOfficeDdl(browser(member), intent.id, "approve")).rejects.toThrow(/权限/);
    const [forged] = await member.query<[unknown[]]>("UPDATE $intent SET status = 'approved' RETURN AFTER", { intent: new StringRecordId(intent.id) });
    expect(forged).toHaveLength(0);
    const [forgedNote] = await member.query<[unknown[]]>("UPDATE $note SET answer = {action:'answered'}, resolved_at = time::now() RETURN AFTER", {
      note: new StringRecordId(intent.notification),
    }).collect();
    expect(forgedNote).toHaveLength(0);
    expect((await readOfficeDdl(connection, intent.id)).status).toBe("requested");

    expect((await decideOfficeDdl(connection, intent.id, "approve")).status).toBe("succeeded");
    const [fields] = await admin.query<[Record<string, string>]>("RETURN (INFO FOR TABLE ent_sales).fields");
    expect(fields?.note).toMatch(/TYPE (none \| string|option<string>)/);
    expect((await decideOfficeDdl(connection, intent.id, "approve")).status).toBe("succeeded");
    expect((await reconcileOfficeDdl(connection, intent.id)).status).toBe("succeeded");
    await expect(admin.query("UPDATE $intent SET result = { message: 'tamper' }", { intent: new StringRecordId(intent.id) }).collect()).rejects.toThrow(/terminal/);

    // 先持久终态再投递；浏览器通知丢失也由 adapter 补投，唯一幂等键。
    const wakeDeps = { triggerRuntime: runtime, resolveWorkspace: async () => ({ dbName: fixture.database }),
      callerSession: async () => ({ query: admin.query.bind(admin) }) };
    const input = { slug: "acme", callerToken: "fixture", notificationId: intent.notification };
    expect(await wakeResolvedOfficeRequest(wakeDeps, input)).toMatchObject({ kind: "ok", outcome: "completed" });
    expect(await wakeResolvedOfficeRequest(wakeDeps, input)).toMatchObject({ kind: "ok", outcome: "coalesced" });
    const [[finished]] = await fixture.root.query<[{ status: string }[]]>("SELECT status FROM $task", { task: new StringRecordId(intent.task) });
    expect(finished?.status).toBe("done");
    const [reports] = await fixture.root.query<[unknown[]]>("SELECT id FROM office_report WHERE task = $task", { task: new StringRecordId(intent.task) });
    expect(reports).toHaveLength(1);

    for (const scenario of ["reject", "failure", "refresh", "lost-response", "index"] as const) {
      analyst = await employeeSession(fixture, analystId);
      managerSession = await employeeSession(fixture, managerId);
      const taskId = `office_task:${scenario.replaceAll("-", "_")}`;
      await createOfficeTaskOnce(managerSession, taskId, { goal: `验证 ${scenario}`, assignee: analystId });
      const proposal = await proposeOfficeDdl(analyst, {
        task: taskId, author: analystId, to: "user:owner",
        change: scenario === "index" ? { op: "define_index", table: "ent_sales", index: "by_amount", fields: ["amount"] }
          : scenario === "failure" ? { op: "define_field", table: "ent_sales", field: "amount", type: "string" }
          : { op: "define_table", table: `ent_${scenario.replaceAll("-", "_")}` },
        rationale: "边界验证", impact: "只新增结构",
      });
      await analyst.query("UPDATE $task SET status = 'blocked', result = $result", {
        task: new StringRecordId(taskId), result: { waiting_on: proposal.notification, ddlIntent: proposal.id, count: 1 },
      }).collect();
      if (scenario === "reject") {
        expect((await decideOfficeDdl(connection, proposal.id, "reject")).status).toBe("rejected");
      } else if (scenario === "failure") {
        expect((await decideOfficeDdl(connection, proposal.id, "approve")).status).toBe("failed");
      } else if (scenario === "refresh") {
        await admin.query(`UPDATE $intent SET status = 'approved', result = { message: 'confirmed' }, decided_by = user:owner;
          UPDATE $intent SET status = 'executing', result = { message: 'browser lost' };`, { intent: new StringRecordId(proposal.id) }).collect();
        expect((await decideOfficeDdl(connection, proposal.id, "approve")).status).toBe("executing");
        expect((await reconcileOfficeDdl(connection, proposal.id)).status).toBe("reconciled");
        const [tables] = await admin.query<[Record<string, string>]>("RETURN (INFO FOR DB).tables");
        expect(tables?.ent_refresh).toBeUndefined();
      } else if (scenario === "index") {
        expect((await decideOfficeDdl(connection, proposal.id, "approve")).status).toBe("succeeded");
        const [indexes] = await admin.query<[Record<string, string>]>("RETURN (INFO FOR TABLE ent_sales).indexes");
        expect(indexes.by_amount).toContain("FIELDS amount");
      } else {
        const lost: DdlConnection = { ...connection, transaction: async (run) => {
          await connection.transaction(run);
          throw new Error("socket disconnected after commit");
        } };
        expect((await decideOfficeDdl(lost, proposal.id, "approve")).status).toBe("succeeded");
        expect((await decideOfficeDdl(connection, proposal.id, "approve")).status).toBe("succeeded");
      }
      expect((await wakeResolvedOfficeRequest(wakeDeps, { ...input, notificationId: proposal.notification })).kind).toBe("ok");
      expect((await wakeResolvedOfficeRequest(wakeDeps, { ...input, notificationId: proposal.notification })).kind).toBe("ok");
    }
    const summary = await reconcileOfficeWorkspace({ runtime, root: fixture.root, database: fixture.database });
    expect(summary.failed).toBe(0);
    const [results] = await fixture.root.query<[{ status: string }[]]>("SELECT status FROM office_ddl_intent");
    expect(results.map((result) => result.status).sort()).toEqual(["succeeded", "succeeded", "succeeded", "failed", "rejected", "reconciled"].sort());
  } finally { await runtime.stop(); await employeeRuntime.stop(); }
}, 120_000);

test("限定结构提案拒绝注入、批量、REMOVE、保留表/字段与未知属性", () => {
  for (const change of [
    { op: "remove_table", table: "ent_sales" },
    { op: "define_table", table: "user" },
    { op: "define_table", table: "ent_x; REMOVE TABLE user" },
    { op: "define_field", table: "ent_sales", field: "id", type: "string" },
    { op: "define_field", table: "ent_sales", field: "x", type: "string", sql: "REMOVE TABLE user" },
    [{ op: "define_table", table: "ent_x" }],
  ]) expect(() => normalizeOfficeDdl(change)).toThrow();
});

test("执行事务在途时另一个浏览器核对：迟到 DDL 与成功回执一起回滚", async () => {
  const fixture = await setupFixture("ws_vo05_race");
  const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
  const other = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
  const lifecycle = createEmployeeLifecycle({
    resolveWorkspace: async () => ({ dbName: fixture.database }), callerSession: async () => ({ query: admin.query.bind(admin) }),
    rootSession: async () => fixture.root,
    runtime: { register: async () => undefined, close: async () => undefined },
  });
  const provision = await lifecycle.provision({ slug: "acme", callerToken: "fixture", roleKey: "data-analyst", requestKey: "race" });
  if (provision.kind !== "ok") throw new Error(provision.kind);
  const analyst = await employeeSession(fixture, provision.employee.id);
  await admin.query("CREATE office_task:race CONTENT {goal:'race', assignee:$employee}", {
    employee: new StringRecordId(provision.employee.id) }).collect();
  const proposal = await proposeOfficeDdl(analyst, { task: "office_task:race", author: provision.employee.id, to: "user:owner",
    change: { op: "define_table", table: "ent_race" }, rationale: "并发核对", impact: "只新增表" });
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const connection = browser(admin);
  const held: DdlConnection = { ...connection, transaction: async (run) => connection.transaction(async (tx) => {
    const result = await run(tx);
    reached();
    await released;
    return result;
  }) };
  const execution = decideOfficeDdl(held, proposal.id, "approve");
  try {
    await paused;
    expect((await reconcileOfficeDdl(browser(other), proposal.id)).status).toBe("reconciled");
  } finally { release(); }
  expect((await execution).status).toBe("reconciled");
  const [tables] = await admin.query<[Record<string, string>]>("RETURN (INFO FOR DB).tables");
  expect(tables.ent_race).toBeUndefined();
}, 30_000);

for (const boundary of ["resume", "report", "before-finish", "finish"] as const) {
  test(`DDL 回执 ${boundary} 中断后从 Mastra snapshot 恢复且效果一次`, async () => {
    const fixture = await setupFixture("ws_vo05_recovery");
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    const employees = createEmployeeRuntime({ surrealUrl: fixture.url, namespace: fixture.namespace,
      rootSession: async () => fixture.root });
    const lifecycle = createEmployeeLifecycle({ resolveWorkspace: async () => ({ dbName: fixture.database }),
      callerSession: async () => ({ query: admin.query.bind(admin) }), rootSession: async () => fixture.root, runtime: employees });
    const provision = await lifecycle.provision({ slug: "acme", callerToken: "fixture", roleKey: "data-analyst", requestKey: boundary });
    if (provision.kind !== "ok") throw new Error(provision.kind);
    const employeeId = provision.employee.id;
    const analyst = await employeeSession(fixture, employeeId);
    await admin.query(`CREATE office_meta:office CONTENT {goal:'恢复', primary_contact:user:owner, state:'onboarding', import_state: "skipped"};
      CREATE office_task:recover CONTENT {goal:'恢复报告', assignee:$employee}`, { employee: new StringRecordId(employeeId) }).collect();
    const proposal = await proposeOfficeDdl(analyst, { task: "office_task:recover", author: employeeId, to: "user:owner",
      change: { op: "define_table", table: "ent_recover" }, rationale: "恢复测试", impact: "只新增表" });
    await analyst.query("UPDATE office_task:recover SET status='blocked', result=$result", {
      result: { waiting_on: proposal.notification, ddlIntent: proposal.id, count: 1 } }).collect();
    await decideOfficeDdl(browser(admin), proposal.id, "reject");
    let reached = false;
    const old = createEmployeeTriggerRuntime({
      sessions: {
        async openSession(database, id) {
          const conn = await employees.openSession(database, id);
          return {
            async query<R extends unknown[] = unknown[]>(sql: string, params: Record<string, unknown> = {}): Promise<R> {
              const content = params.content as Record<string, unknown> | undefined;
              const result = params.result as Record<string, unknown> | undefined;
              const matches = boundary === "resume" ? sql.includes("UPDATE employee_effect") && String(params.effectKey).endsWith(":ddl-resume")
                : boundary === "report" ? sql.includes("INSERT IGNORE INTO office_report") && String(content?.id).startsWith("office_report:result_")
                : sql.includes("UPDATE $task") && params.status === "done" && !!result?.ddlIntent;
              const pause = async () => { if (!reached && matches) { reached = true; await new Promise<never>(() => {}); } };
              if (boundary === "before-finish") await pause();
              const rows = await conn.query<R>(sql, params);
              if (boundary !== "before-finish") await pause();
              return rows;
            },
          };
        },
        close: (database, id) => employees.close(database, id),
      }, driver: createMastraEmployeeDriver, sleep: () => Promise.resolve(),
    });
    registerProjectManagerHandlers(old);
    old.start();
    void notifyOfficeRequestResolved(old, { database: fixture.database, employeeId, notificationId: proposal.notification });
    await waitFor(async () => reached ? true : null);
    await fixture.root.query(`UPDATE employee_trigger SET lease_expires_at=time::now()-1s WHERE status='running';
      UPDATE employee_window SET lease_expires_at=time::now()-1s;`).collect();
    const recovery = createEmployeeTriggerRuntime({ sessions: employees, driver: createMastraEmployeeDriver, sleep: () => Promise.resolve() });
    registerProjectManagerHandlers(recovery);
    recovery.start();
    try {
      expect(await recovery.reconcile({ database: fixture.database, employeeId })).toMatchObject({ reclaimed: 1, completed: 1 });
      const [[task]] = await fixture.root.query<[{ status: string; result: { ddlStatus: string } }[]]>("SELECT status,result FROM office_task:recover");
      expect(task).toMatchObject({ status: "done", result: { ddlStatus: "rejected" } });
      const [reports] = await fixture.root.query<[unknown[]]>("SELECT id FROM office_report WHERE task=office_task:recover");
      expect(reports).toHaveLength(1);
      expect((await notifyOfficeRequestResolved(recovery, { database: fixture.database, employeeId, notificationId: proposal.notification })).outcome).toBe("coalesced");
      expect((await readOfficeDdl(browser(admin), proposal.id)).status).toBe("rejected");
    } finally {
      await recovery.stop();
      void old.stop();
      await employees.stop();
    }
  }, 60_000);
}
