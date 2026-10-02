import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { runDailyClaimsRiskCheck, type ClaimsRiskStore } from "./daily-claims-risk";
import { getEmployeeTriggerRuntime } from "./employee-service";
import type {
  EmployeeTriggerRuntime,
  TriggerSession,
} from "./employee-trigger-runtime";
import { createSurrealClaimsRiskStore, type EmployeeQuerySession } from "./surreal-claims-risk-store";

/**
 * 每日债权风险 trigger adapter（VER03）：定时观察只负责两件事——
 * 用 root 枚举 active workspace 并保证专用员工身份/凭证存在（启动枚举与凭证维护），
 * 然后向通用 trigger runtime 投递幂等触发。employee SIGNIN、执行窗口、
 * 触发持久化、结果与关停全部归 runtime；用户提醒由 handler 内既有检查逻辑产生。
 */

export const CLAIMS_RISK_REASON = "daily-claims-risk";

export type ClaimsRiskEmployeeTarget = {
  database: string;
  /** 员工 user record id（如 "user:claims_risk_reminder"）。 */
  employeeId: string;
};

export type ClaimsRiskTriggerQueue = Pick<EmployeeTriggerRuntime, "enqueue" | "reconcile">;

export type ClaimsRiskDispatchDeps = {
  now?: () => Date;
  listEmployees?: () => Promise<ClaimsRiskEmployeeTarget[]>;
  /** 测试注入 trigger runtime；默认生产单例。 */
  triggerRuntime?: ClaimsRiskTriggerQueue;
};

export type ClaimsRiskDispatchResult = {
  targets: number;
  completed: number;
  /** 当日幂等键已由先前投递完成，本次只观察不重跑。 */
  coalesced: number;
  failed: number;
};

export type RootEmployeeProvisioningSession = {
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
};

const CLAIMS_RISK_EMPLOYEE_SUBJECT = "claims-risk-reminder";
const CLAIMS_RISK_EMPLOYEE_ID = "user:claims_risk_reminder";

export async function ensureClaimsRiskEmployee(
  root: RootEmployeeProvisioningSession,
  generateSecret: () => string = () => `${crypto.randomUUID()}${crypto.randomUUID()}`,
): Promise<{ employeeId: string; subject: string; secret: string }> {
  let employees = await root.query<{ id: unknown; subject?: unknown }>(
    `SELECT id, subject FROM ${CLAIMS_RISK_EMPLOYEE_ID}`,
  );
  if (employees.length === 0) {
    await root.query(
      `CREATE ${CLAIMS_RISK_EMPLOYEE_ID} CONTENT {
        email: "claims-risk-reminder@virtual.local",
        subject: $subject,
        kind: "virtual",
        is_admin: false,
        display_name: "债权风险提醒专员",
        virtual_profile: { status: "active", role_key: "claims-risk-reminder" }
      }`,
      { subject: CLAIMS_RISK_EMPLOYEE_SUBJECT },
    );
    employees = [{ id: CLAIMS_RISK_EMPLOYEE_ID, subject: CLAIMS_RISK_EMPLOYEE_SUBJECT }];
  }
  const employeeId = typeof employees[0]?.id === "string" ? employees[0].id : CLAIMS_RISK_EMPLOYEE_ID;
  const employeeRecord = new StringRecordId(employeeId);
  const subject = typeof employees[0]?.subject === "string"
    ? employees[0].subject
    : CLAIMS_RISK_EMPLOYEE_SUBJECT;
  const credentials = await root.query<{ secret?: unknown }>(
    "SELECT secret FROM employee_credential WHERE employee = $employee LIMIT 1",
    { employee: employeeRecord },
  );
  if (typeof credentials[0]?.secret === "string" && credentials[0].secret) {
    return { employeeId, subject, secret: credentials[0].secret };
  }
  const secret = generateSecret();
  await root.query(
    `INSERT INTO employee_credential {
      employee: $employee,
      secret: $secret,
      created_at: time::now()
    }
    ON DUPLICATE KEY UPDATE secret = $input.secret, rotated_at = time::now()`,
    { employee: employeeRecord, secret },
  );
  return { employeeId, subject, secret };
}

function shanghaiDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * 债权提醒是可选模板包能力（bankruptcy-claims）：只在工作区真实启用了该包
 * 工作簿（risk_reminders_enabled = true）时才 provision 专用员工身份/凭证。
 * 通用工作区连门控检查都发生在其自身库内一次轻量 SELECT——不创建
 * claims-risk 员工、凭证或触发，默认产品不留法律域尾迹。
 */
export async function listClaimsRiskEmployees(
  getSession: typeof getRootDatabaseSession = getRootDatabaseSession,
): Promise<ClaimsRiskEmployeeTarget[]> {
  const system = await getSession("_system");
  const [workspaces] = await system.query<[{ db_name?: unknown }[]]>(
    'SELECT db_name FROM workspace WHERE status = "active"',
  );
  const targets: ClaimsRiskEmployeeTarget[] = [];
  for (const workspace of workspaces) {
    const database = typeof workspace.db_name === "string" ? workspace.db_name : "";
    if (!database) continue;
    const root = await getSession(database);
    const [enabledWorkbooks] = await root.query<[{ id?: unknown }[]]>(
      `SELECT id FROM workbook
       WHERE risk_reminders_enabled = true AND template.key = "bankruptcy-claims"
       LIMIT 1`,
    );
    if (!enabledWorkbooks?.length) continue;
    const provisioningSession: RootEmployeeProvisioningSession = {
      async query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>) {
        const [rows] = await root.query<[T[]]>(sql, params);
        return rows ?? [];
      },
    };
    const employee = await ensureClaimsRiskEmployee(provisioningSession);
    targets.push({ database, employeeId: employee.employeeId });
  }
  return targets;
}

function asEmployeeQuerySession(session: TriggerSession): EmployeeQuerySession {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>) {
      const results = await session.query<[T[]]>(sql, params);
      return results?.[0] ?? [];
    },
  };
}

/**
 * 把债权风险岗位逻辑挂到 trigger runtime：handler 拿到的 session 就是该员工的
 * RECORD 会话，所有业务写（risk_check_run / user_notification）归因到员工本人。
 * checkDate 以 payload_ref 引用传递，与幂等键里的日期一致。
 *
 * 岗位级副作用经 runEffect 记账（VER04）：崩溃发生在"效果已提交、snapshot
 * 未更新"之间时，重放窗口读到 committed 账本直接回既有结果，不重复执行检查。
 * 账本内部的 reminder 落库本身还有 dedupe_key 唯一索引兜底——两层幂等。
 */
export function registerClaimsRiskHandler(
  runtime: Pick<EmployeeTriggerRuntime, "registerHandler">,
  deps: { now?: () => Date; storeFor?: (session: TriggerSession) => ClaimsRiskStore } = {},
): void {
  const now = deps.now ?? (() => new Date());
  const storeFor = deps.storeFor
    ?? ((session: TriggerSession) => createSurrealClaimsRiskStore(asEmployeeQuerySession(session)));
  runtime.registerHandler(CLAIMS_RISK_REASON, async ({ trigger, session, effects }) =>
    effects.runEffect("risk-check", () =>
      runDailyClaimsRiskCheck(storeFor(session), {
        checkDate: trigger.payloadRef ?? shanghaiDateKey(now()),
        checkedAt: now(),
      }),
    ),
  );
}

export async function runClaimsRiskReminderDispatch(
  deps: ClaimsRiskDispatchDeps = {},
): Promise<ClaimsRiskDispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const checkDate = shanghaiDateKey(now);
  const targets = await (deps.listEmployees ?? listClaimsRiskEmployees)();
  const runtime = deps.triggerRuntime ?? getEmployeeTriggerRuntime();
  let completed = 0;
  let coalesced = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      // 先回收上次进程留下的孤儿窗口（pending / 过期 lease），再投递当日触发。
      await runtime.reconcile(target).catch((cause) => {
        console.warn("[claims-risk] reconcile skipped", {
          database: target.database,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
      const result = await runtime.enqueue({
        database: target.database,
        employeeId: target.employeeId,
        reason: CLAIMS_RISK_REASON,
        payloadRef: checkDate,
        chainDepth: 0,
        idempotencyKey: `${CLAIMS_RISK_REASON}:${target.employeeId}:${checkDate}`,
      });
      if (result.outcome === "completed") completed += 1;
      else if (result.outcome === "coalesced") coalesced += 1;
      else failed += 1;
    } catch (cause) {
      failed += 1;
      console.error("[claims-risk] trigger delivery failed", {
        database: target.database,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { targets: targets.length, completed, coalesced, failed };
}

export type ClaimsRiskDispatcherHandle = { stop(): Promise<void> };

export function startClaimsRiskReminderDispatcher(
  deps: ClaimsRiskDispatchDeps & {
    intervalMs?: number;
    triggerRuntime?: EmployeeTriggerRuntime;
    storeFor?: (session: TriggerSession) => ClaimsRiskStore;
  } = {},
): ClaimsRiskDispatcherHandle {
  const runtime = deps.triggerRuntime ?? getEmployeeTriggerRuntime();
  registerClaimsRiskHandler(runtime, { now: deps.now, storeFor: deps.storeFor });
  runtime.start();
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = runClaimsRiskReminderDispatch({ ...deps, triggerRuntime: runtime })
      .catch((cause) => console.error("[claims-risk] dispatch failed", {
        message: cause instanceof Error ? cause.message : String(cause),
      }))
      .finally(() => { running = null; });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs ?? 60_000);
  return {
    async stop() {
      clearInterval(timer);
      await running;
      await runtime.stop();
    },
  };
}
