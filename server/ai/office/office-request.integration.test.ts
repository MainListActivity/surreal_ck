import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
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
  wakeResolvedOfficeRequest,
  type OfficeBootstrapResult,
  type OfficeRequestWakeResult,
  notifyOfficeRequestResolved,
} from "./office-trigger-adapter";
import { registerProjectManagerHandlers } from "./project-manager";
import { createOfficeRequest } from "./office-domain";

/**
 * VO03 真实 SurrealDB 纵切：PM 经 ask_human brief 发起结构化人类请求 → 通知落
 * 同一 user_notification 收件箱 → 收件人 CAS 写终态 → wake 端点经 adapter 以
 * office-request:<id> 幂等键恰好唤醒一次后续执行 → PM 回读答复并继续任务。
 * 断言：
 * - 请求携带 task/run/trigger 关联；员工可读回自己的请求，非收件人不可见；
 * - answer/reject/cancel 都是持久终态：重复 CAS、重复点击、守卫改写全部收敛；
 * - 唤醒幂等：重复 wake、reconcile 补投撞同一触发键，不产生第二次后续执行；
 * - 唤醒丢失时 reconcile 补投——收件人不需要重新回答；
 * - 债权提醒（purpose=claims-risk）走同一收件箱且老 resolution 路径不受影响。
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
  const publicKey = await exportSPKI(keys.publicKey);
  const issuer = "https://vo03-fixture.example.test";
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
  wake: (input: {
    slug: string;
    callerToken: string;
    notificationId: string;
  }) => Promise<OfficeRequestWakeResult>;
};

/** token 约定："<sub>:<ac>"——admin 走 JWT access，participant 走 RECORD access。 */
function callerSessionFor(fixture: Fixture) {
  return (_db: string, token: string) => {
    const [sub, ac] = token.split(":");
    return jwtSession(fixture, { sub: sub ?? token, ac: ac === "admin" ? "admin" : "participant" });
  };
}

type QueryInterruption = {
  phase: "before" | "after";
  matches(sql: string, params: Record<string, unknown>): boolean;
  reached: boolean;
};

function buildStack(fixture: Fixture, interruption?: QueryInterruption): Stack {
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
    callerSession: callerSessionFor(fixture),
    rootSession: async () => ({
      query: (sql: string, params?: Record<string, unknown>) =>
        fixture.root.query(sql, params),
    }),
    runtime: employeeRuntime,
  });
  const triggerRuntime = createEmployeeTriggerRuntime({
    sessions: interruption ? {
      async openSession(database, employeeId) {
        const session = await employeeRuntime.openSession(database, employeeId);
        return {
          async query<R extends unknown[] = unknown[]>(sql: string, params: Record<string, unknown> = {}): Promise<R> {
            const interrupt = async (phase: "before" | "after") => {
              if (!interruption.reached && interruption.phase === phase && interruption.matches(sql, params)) {
                interruption.reached = true;
                // 模拟进程消失：旧窗口不再提交任何状态；新 runtime 从过期租约恢复。
                await new Promise<never>(() => {});
              }
            };
            await interrupt("before");
            const result = await session.query<R>(sql, params);
            await interrupt("after");
            return result;
          },
        };
      },
      close: (database, employeeId) => employeeRuntime.close(database, employeeId),
    } : employeeRuntime,
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
          callerSession: callerSessionFor(fixture),
        },
        input,
      ),
    wake: (input) =>
      wakeResolvedOfficeRequest(
        {
          triggerRuntime,
          resolveWorkspace: async () => ({ dbName: fixture.database }),
          callerSession: callerSessionFor(fixture),
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

/** 与浏览器侧一致的终态 CAS 写入：只有首个提交落库。 */
async function memberResolve(
  conn: Surreal,
  id: string,
  input: { action: string; text?: string },
): Promise<number> {
  const [result] = await conn.query<[unknown[]]>(
    `UPDATE $notification SET
       answer = $answer,
       resolution = $resolution,
       resolved_at = time::now()
     WHERE resolved_at = NONE
     RETURN AFTER;`,
    {
      notification: new StringRecordId(id),
      answer: { action: input.action, text: input.text ?? "", at: new Date().toISOString() },
      resolution: input.text?.trim() || `已${input.action === "answered" ? "答复" : input.action === "rejected" ? "拒绝" : "取消"}`,
    },
  );
  return (result ?? []).length;
}

describe("VO03 人类请求一次性解决闭环（真实 SurrealDB）", () => {
  test("ask_human → 收件箱 → 答复唤醒恰好一次 → 任务续跑 done；重试/重放/reconcile 收敛", async () => {
    const fixture = await setupFixture("ws_vo03_main");
    const stack = buildStack(fixture);
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    await admin.query(
      `CREATE office_meta:office CONTENT {
        goal: "合并重复债权行",
        primary_contact: user:member,
        state: "onboarding"
      };`,
    ).collect();
    expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub:admin" })).kind).toBe("ok");
    const pmId = officeManagerEmployeeId(fixture.database);
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:pm_initial");
      return t?.status === "done" ? t : null;
    });

    // admin（模拟浏览器/产品面）建一个带 ask_human brief 的任务，经 adapter 投递。
    await admin.query(
      `CREATE office_task:ask_merge CONTENT {
        goal: "确定重复债权合并口径",
        assignee: ${pmId},
        completion: "按确认口径输出合并方案报告",
        brief: { ask_human: { prompt: "两笔债权金额一致日期不同，按哪笔为准？", to: "user:member", question_type: "free-text" } }
      };`,
    ).collect();
    const dispatched = await notifyOfficeTask(stack.triggerRuntime, {
      database: fixture.database,
      assigneeId: pmId,
      taskId: "office_task:ask_merge",
    });
    expect(dispatched.outcome).toBe("completed");

    // 任务被挂起为 blocked；请求通知落同一 user_notification 收件箱，
    // 携带 task / run / trigger 关联。
    const [task] = await rows<{ status: string }>(fixture,
      "SELECT status FROM office_task:ask_merge");
    expect(task?.status).toBe("blocked");
    const requests = await rows<Record<string, unknown>>(fixture,
      `SELECT id, purpose, to_user, from_employee, task, payload, resolved_at
       FROM user_notification WHERE purpose = "office-request"`);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(String(request.id)).toMatch(/^user_notification:ofreq_office_task_ask_merge_[0-9a-f]{10}$/);
    expect(String(request.to_user)).toBe("user:member");
    expect(String(request.from_employee)).toBe(pmId);
    expect(String(request.task)).toBe("office_task:ask_merge");
    expect(request.resolved_at ?? null).toBeNull();
    const payload = request.payload as Record<string, unknown>;
    expect(payload.prompt).toBe("两笔债权金额一致日期不同，按哪笔为准？");
    expect(payload.question_type).toBe("free-text");
    expect(typeof payload.run_id).toBe("string");
    expect(String(payload.request_trigger)).toMatch(/^employee_trigger:/);
    const notificationId = String(request.id);

    // 未落终态时 wake 拒绝（409 语义），不消耗触发键。
    const premature = await stack.wake({
      slug: "acme", callerToken: "member-sub:participant", notificationId,
    });
    expect(premature.kind).toBe("unresolved");
    expect(await rows(fixture,
      `SELECT id FROM employee_trigger WHERE reason = "office-request-resolved"`)).toHaveLength(0);

    // 收件人 CAS 写终态：答复持久化。
    const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
    expect(await memberResolve(member, notificationId, { action: "answered", text: "以先到期的为准" }))
      .toBe(1);
    // 直接绕过浏览器 CAS 也不能改写/清空首个终态。
    await expect(member.query(
      `UPDATE $notification SET answer = { action: "rejected", text: "改口" };`,
      { notification: new StringRecordId(notificationId) },
    ).collect()).rejects.toThrow("resolution is terminal");
    // 重复提交（重复点击/刷新重试）：CAS 写不到行，首个终态不被改写。
    expect(await memberResolve(member, notificationId, { action: "rejected", text: "改口" }))
      .toBe(0);
    const [afterDup] = await rows<{ resolution: string }>(fixture,
      `SELECT resolution FROM ${notificationId}`);
    expect(afterDup?.resolution).toBe("以先到期的为准");

    // 收件人唤醒请求员工——恰好一次后续执行：PM 回读答复、留消息、任务收 done。
    const woken = await stack.wake({
      slug: "acme", callerToken: "member-sub:participant", notificationId,
    });
    expect(woken).toMatchObject({ kind: "ok" });
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:ask_merge");
      return t?.status === "done" ? t : null;
    });
    const answerMsg = await rows<{ id: string; author: unknown; body: string }>(fixture,
      `SELECT id, author, body FROM office_message WHERE id = office_message:pm_answer_${notificationId.replace(/[^a-zA-Z0-9_]/g, "_")}`);
    expect(answerMsg).toHaveLength(1);
    expect(String(answerMsg[0]!.author)).toBe(pmId);
    expect(answerMsg[0]!.body).toContain("已答复");
    expect(answerMsg[0]!.body).toContain("以先到期的为准");
    const [report] = await rows<{ summary: string; to: unknown }>(fixture,
      "SELECT summary, to FROM office_report:pm_answer_office_task_ask_merge");
    expect(report?.summary).toContain("以先到期的为准");
    expect(String(report!.to)).toBe("user:member");

    // 恰好一次：重复 wake 与 reconcile 都收敛 coalesced，答复消息/报告各一条。
    const dupWake = await stack.wake({
      slug: "acme", callerToken: "member-sub:participant", notificationId,
    });
    expect(dupWake).toMatchObject({ kind: "ok", outcome: "coalesced" });
    const summary = await reconcileOfficeWorkspace({
      runtime: stack.triggerRuntime,
      root: { query: (sql, params) => fixture.root.query(sql, params) },
      database: fixture.database,
    });
    expect(summary.failed).toBe(0);
    await Bun.sleep(150);
    const triggers = await rows<{ id: string }>(fixture,
      `SELECT id FROM employee_trigger WHERE reason = "office-request-resolved"`);
    expect(triggers).toHaveLength(1);
    expect(await rows(fixture,
      `SELECT id FROM office_message WHERE id = office_message:pm_answer_${notificationId.replace(/[^a-zA-Z0-9_]/g, "_")}`))
      .toHaveLength(1);

    // 员工可读回自己发出的请求（select 放行 from_employee）。
    const pm = await stack.employeeRuntime.openSession(fixture.database, pmId);
    try {
      const [visible] = await pm.query<[unknown[]]>(
        `SELECT id FROM ${notificationId};`,
      );
      expect(visible).toHaveLength(1);
    } finally {
      await stack.employeeRuntime.close(fixture.database, pmId);
    }

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 120_000);

  test("越权与补投：非收件人读不到/写不进；唤醒丢失由 reconcile 补投；拒绝与取消都是终态", async () => {
    const fixture = await setupFixture("ws_vo03_bounds");
    const stack = buildStack(fixture);
    const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
    await admin.query(
      `CREATE office_meta:office CONTENT {
        goal: "权限与补投", primary_contact: user:member, state: "onboarding"
      };`,
    ).collect();
    expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub:admin" })).kind).toBe("ok");
    const pmId = officeManagerEmployeeId(fixture.database);
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:pm_initial");
      return t?.status === "done" ? t : null;
    });

    await admin.query(
      `CREATE office_task:ask_pick CONTENT {
        goal: "请求选择口径",
        assignee: ${pmId},
        brief: { ask_human: { prompt: "选哪个批次？", to: "user:member", question_type: "choice", options: ["A批", "B批"] } }
      };
      CREATE office_task:ask_cancel CONTENT {
        goal: "将被取消的请求",
        assignee: ${pmId},
        brief: { ask_human: { prompt: "还需要继续吗？", to: "user:member" } }
      };`,
    ).collect();
    for (const taskId of ["office_task:ask_pick", "office_task:ask_cancel"]) {
      const r = await notifyOfficeTask(stack.triggerRuntime, {
        database: fixture.database, assigneeId: pmId, taskId,
      });
      expect(r.outcome).toBe("completed");
    }
    const requests = await rows<{ id: string; task: string }>(fixture,
      `SELECT id, task FROM user_notification WHERE purpose = "office-request" ORDER BY id`);
    expect(requests).toHaveLength(2);
    const byTask = new Map(requests.map((r) => [String(r.task), String(r.id)]));
    const pickId = byTask.get("office_task:ask_pick")!;
    const cancelId = byTask.get("office_task:ask_cancel")!;

    // 非收件人 participant：读不到行、写不进终态、wake 得到 not-found。
    const other = await jwtSession(fixture, { sub: "other-sub", ac: "participant" });
    const [seen] = await other.query<[unknown[]]>(`SELECT id FROM ${pickId};`);
    expect(seen).toHaveLength(0);
    expect(await memberResolve(other, pickId, { action: "answered", text: "越权答复" })).toBe(0);
    const foreignWake = await stack.wake({
      slug: "acme", callerToken: "other-sub:participant", notificationId: pickId,
    });
    expect(foreignWake.kind).toBe("not-found");
    await other.close();

    // 收件人拒绝 ask_pick——终态落库但**不**调用 wake（模拟浏览器在两者之间崩溃）。
    const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
    expect(await memberResolve(member, pickId, { action: "rejected", text: "不选，重新盘点" })).toBe(1);

    // reconcile 补投丢失的唤醒：同幂等键投递，收件人不需要重新回答。
    const summary = await reconcileOfficeWorkspace({
      runtime: stack.triggerRuntime,
      root: { query: (sql, params) => fixture.root.query(sql, params) },
      database: fixture.database,
    });
    expect(summary.dispatched).toBeGreaterThanOrEqual(1);
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:ask_pick");
      return t?.status === "done" ? t : null;
    });
    const rejectMsg = await rows<{ body: string }>(fixture,
      `SELECT body FROM office_message WHERE id = office_message:pm_answer_${pickId.replace(/[^a-zA-Z0-9_]/g, "_")}`);
    expect(rejectMsg).toHaveLength(1);
    expect(rejectMsg[0]!.body).toContain("已拒绝");
    // 拒绝终态不被补投改写。
    const [pickRow] = await rows<{ resolution: string }>(fixture, `SELECT resolution FROM ${pickId}`);
    expect(pickRow?.resolution).toBe("不选，重新盘点");

    // 取消路径：成员直接取消请求——任务由 resolved handler 收口。
    expect(await memberResolve(member, cancelId, { action: "cancelled" })).toBe(1);
    const woken = await stack.wake({
      slug: "acme", callerToken: "member-sub:participant", notificationId: cancelId,
    });
    expect(woken).toMatchObject({ kind: "ok" });
    await waitFor(async () => {
      const [t] = await rows<{ status?: unknown }>(fixture,
        "SELECT status FROM office_task:ask_cancel");
      return t?.status === "done" ? t : null;
    });
    const [cancelRow] = await rows<{ resolution: string; answer: { action?: string } }>(fixture,
      `SELECT resolution, answer FROM ${cancelId}`);
    expect(cancelRow?.answer?.action).toBe("cancelled");

    // 债权提醒兼容：员工建一条 claims-risk 通知，收件人走老 resolution 路径解决；
    // 它不出现在 office-request 唤醒面（purpose 闸），也不被 request UI 误认。
    const pm = await stack.employeeRuntime.openSession(fixture.database, pmId);
    try {
      await pm.query(
        `CREATE user_notification:risk_compat CONTENT {
          dedupe_key: "risk-compat-1", to_user: user:member, purpose: "claims-risk",
          title: "材料缺失：签收单", body: "缺少三月份签收单", severity: "warning"
        };`,
      ).collect();
    } finally {
      await stack.employeeRuntime.close(fixture.database, pmId);
    }
    const [riskVisible] = await member.query<[unknown[]]>(
      `SELECT id FROM user_notification:risk_compat;`,
    );
    expect(riskVisible).toHaveLength(1);
    await member.query(
      `UPDATE user_notification:risk_compat SET resolution = "已补齐材料", resolved_at = time::now();`,
    ).collect();
    const [riskRows] = await member.query<[{ resolution?: string }[]]>(
      `SELECT resolution FROM user_notification:risk_compat;`,
    );
    expect(riskRows?.[0]?.resolution).toBe("已补齐材料");
    // claims-risk 行不是人类请求：wake 拒绝为 not-request，不产生触发。
    const notRequest = await stack.wake({
      slug: "acme", callerToken: "member-sub:participant",
      notificationId: "user_notification:risk_compat",
    });
    expect(notRequest.kind).toBe("not-request");

    await stack.triggerRuntime.stop();
    await stack.employeeRuntime.stop();
  }, 120_000);
});


describe("VO03 续跑中断恢复（真实 fork + Mastra + effect 账本）", () => {
  const boundaries = ["resume-committed", "report-written", "before-finish", "finish-written"] as const;
  for (const boundary of boundaries) {
    test(`${boundary} 中断后续跑收尾，重复 wake 不重复业务效果`, async () => {
      const fixture = await setupFixture("ws_vo03_recovery");
      const interruption: QueryInterruption = {
        reached: false,
        phase: boundary === "before-finish" ? "before" : "after",
        matches(sql, params) {
          if (boundary === "resume-committed") {
            return sql.includes("UPDATE employee_effect") &&
              String(params.effectKey).endsWith(":resume-task");
          }
          if (boundary === "report-written") {
            const content = params.content as Record<string, unknown> | undefined;
            return sql.includes("INSERT IGNORE INTO office_report") &&
              String(content?.id).startsWith("office_report:pm_answer_");
          }
          const result = params.result as Record<string, unknown> | undefined;
          return sql.includes("UPDATE $task") && params.status === "done" && !!result?.requestId;
        },
      };
      const stack = buildStack(fixture, interruption);
      const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
      await admin.query(`CREATE office_meta:office CONTENT {
        goal: "恢复派单", primary_contact: user:member, state: "onboarding"
      };`).collect();
      expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub:admin" })).kind).toBe("ok");
      const pmId = officeManagerEmployeeId(fixture.database);
      await waitFor(async () => {
        const [t] = await rows<{ status: string }>(fixture, "SELECT status FROM office_task:pm_initial");
        return t?.status === "done" ? true : null;
      });
      await admin.query(`CREATE office_task:recover CONTENT {
        goal: "按答复交付报告", assignee: ${pmId},
        brief: { ask_human: { prompt: "采用哪个口径？", to: "user:member" } }
      };`).collect();
      expect((await notifyOfficeTask(stack.triggerRuntime, {
        database: fixture.database, assigneeId: pmId, taskId: "office_task:recover",
      })).outcome).toBe("completed");
      const [request] = await rows<{ id: unknown }>(fixture,
        'SELECT id FROM user_notification WHERE purpose = "office-request"');
      const notificationId = String(request!.id);
      const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
      expect(await memberResolve(member, notificationId, { action: "answered", text: "口径A" })).toBe(1);
      void stack.wake({ slug: "acme", callerToken: "member-sub:participant", notificationId });
      await waitFor(async () => interruption.reached ? true : null);
      const [before] = await rows<{ status: string }>(fixture, "SELECT status FROM office_task:recover");
      expect(before!.status).toBe(boundary === "finish-written" ? "done" : "in_progress");
      // 拨快租约时钟；旧窗口被悬停，新 runtime 使用真实持久 snapshot restart。
      await fixture.root.query(`
        UPDATE employee_trigger SET lease_expires_at = time::now() - 1s WHERE status = "running";
        UPDATE employee_window SET lease_expires_at = time::now() - 1s;
      `).collect();
      const recovery = createEmployeeTriggerRuntime({
        sessions: stack.employeeRuntime, driver: createMastraEmployeeDriver,
        sleep: () => Promise.resolve(),
      });
      registerProjectManagerHandlers(recovery);
      recovery.start();
      try {
        const summary = await recovery.reconcile({ database: fixture.database, employeeId: pmId });
        expect(summary).toMatchObject({ reclaimed: 1, completed: 1 });
        const [after] = await rows<{ status: string; result: { requestId: string } }>(fixture,
          "SELECT status, result FROM office_task:recover");
        expect(after).toMatchObject({ status: "done", result: { requestId: notificationId } });
        const reports = await rows<{ summary: string }>(fixture,
          'SELECT summary FROM office_report WHERE task = office_task:recover');
        expect(reports).toHaveLength(1);
        expect(reports[0]!.summary).toContain("口径A");
        const key = notificationId.replace(/[^a-zA-Z0-9_]/g, "_");
        expect(await rows(fixture, `SELECT id FROM office_message:pm_answer_${key}`)).toHaveLength(1);
        const triggers = await rows<{ id: unknown; status: string; attempts: number }>(fixture,
          'SELECT id, status, attempts FROM employee_trigger WHERE reason = "office-request-resolved"');
        expect(triggers).toHaveLength(1);
        expect(triggers[0]).toMatchObject({ status: "completed", attempts: 2 });
        const effects = await rows<{ status: string }>(fixture,
          'SELECT status FROM employee_effect WHERE trigger = $trigger',
          { trigger: new StringRecordId(String(triggers[0]!.id)) });
        expect(effects).toHaveLength(4);
        expect(effects.every((effect) => effect.status === "committed")).toBe(true);
        expect((await notifyOfficeRequestResolved(recovery, {
          database: fixture.database, notificationId, employeeId: pmId,
        })).outcome).toBe("coalesced");
        expect(await rows(fixture, 'SELECT id FROM office_report WHERE task = office_task:recover')).toHaveLength(1);
      } finally {
        await recovery.stop();
        // 旧进程的 promise 被刻意悬停，不能 await 排空；关闭实际员工会话。
        void stack.triggerRuntime.stop();
        await stack.employeeRuntime.stop();
      }
    }, 60_000);
  }
});


test("VO03 续跑关联守卫：其他请求、其他 assignee 和取消终态均不收尾", async () => {
  const fixture = await setupFixture("ws_vo03_unrelated");
  const stack = buildStack(fixture);
  const admin = await jwtSession(fixture, { sub: "owner-sub", ac: "admin" });
  await admin.query(`CREATE office_meta:office CONTENT {
    goal: "关联守卫", primary_contact: user:member, state: "onboarding"
  };`).collect();
  expect((await stack.bootstrap({ slug: "acme", callerToken: "owner-sub:admin" })).kind).toBe("ok");
  const pmId = officeManagerEmployeeId(fixture.database);
  await waitFor(async () => {
    const [t] = await rows<{ status: string }>(fixture, "SELECT status FROM office_task:pm_initial");
    return t?.status === "done" ? true : null;
  });
  const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
  for (const caseName of ["blocked", "in_progress", "other-assignee", "cancelled"] as const) {
    const taskId = `office_task:unrelated_${caseName.replaceAll("-", "_")}`;
    const notificationId = `user_notification:unrelated_${caseName.replaceAll("-", "_")}`;
    const status = caseName === "other-assignee" ? "blocked" : caseName;
    await admin.query(`CREATE $task CONTENT {
      goal: "不得被本请求收尾", assignee: $assignee
    }; UPDATE $task SET status = $status, result = $result;`, {
      task: new StringRecordId(taskId),
      assignee: new StringRecordId(caseName === "other-assignee" ? "user:member" : pmId),
      status,
      result: { waiting_on: caseName === "other-assignee" ? notificationId : "user_notification:different" },
    }).collect();
    const pm = await stack.employeeRuntime.openSession(fixture.database, pmId);
    try {
      await createOfficeRequest(pm, {
        id: notificationId, dedupeKey: notificationId, task: taskId,
        to: "user:member", prompt: "独立请求",
      });
    } finally {
      await stack.employeeRuntime.close(fixture.database, pmId);
    }
    expect(await memberResolve(member, notificationId, { action: "answered", text: "答复" })).toBe(1);
    expect(await stack.wake({ slug: "acme", callerToken: "member-sub:participant", notificationId }))
      .toMatchObject({ kind: "ok", outcome: "completed" });
    const [task] = await rows<{ status: string }>(fixture, "SELECT status FROM $task", {
      task: new StringRecordId(taskId),
    });
    expect(task!.status).toBe(status);
    expect(await rows(fixture, "SELECT id FROM office_report WHERE task = $task", {
      task: new StringRecordId(taskId),
    })).toHaveLength(0);
  }
  await stack.triggerRuntime.stop();
  await stack.employeeRuntime.stop();
}, 60_000);
