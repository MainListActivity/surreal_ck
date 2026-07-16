import { StringRecordId, Surreal } from "surrealdb";
import { env } from "../../src/env";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { runDailyClaimsRiskCheck, type ClaimsRiskStore } from "./daily-claims-risk";
import { createSurrealClaimsRiskStore, type EmployeeQuerySession } from "./surreal-claims-risk-store";

export type ClaimsRiskEmployeeTarget = {
  database: string;
  subject: string;
  secret: string;
};

export type EmployeeStoreWindow = {
  store: ClaimsRiskStore;
  close(): Promise<void>;
};

export type ClaimsRiskDispatchDeps = {
  now?: () => Date;
  listEmployees?: () => Promise<ClaimsRiskEmployeeTarget[]>;
  openEmployeeStore?: (target: ClaimsRiskEmployeeTarget) => Promise<EmployeeStoreWindow>;
};

export type ClaimsRiskDispatchResult = { targets: number; completed: number; failed: number };

export type RootEmployeeProvisioningSession = {
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
};

const CLAIMS_RISK_EMPLOYEE_SUBJECT = "claims-risk-reminder";

export async function ensureClaimsRiskEmployee(
  root: RootEmployeeProvisioningSession,
  generateSecret: () => string = () => `${crypto.randomUUID()}${crypto.randomUUID()}`,
): Promise<{ subject: string; secret: string }> {
  let employees = await root.query<{ id: unknown; subject?: unknown }>(
    "SELECT id, subject FROM user:claims_risk_reminder",
  );
  if (employees.length === 0) {
    await root.query(
      `CREATE user:claims_risk_reminder CONTENT {
        email: "claims-risk-reminder@virtual.local",
        subject: $subject,
        kind: "virtual",
        is_admin: false,
        display_name: "债权风险提醒专员",
        virtual_profile: { status: "active", role_key: "claims-risk-reminder" }
      }`,
      { subject: CLAIMS_RISK_EMPLOYEE_SUBJECT },
    );
    employees = [{ id: "user:claims_risk_reminder", subject: CLAIMS_RISK_EMPLOYEE_SUBJECT }];
  }
  const employeeId = employees[0]?.id;
  const employeeRecord = typeof employeeId === "string" ? new StringRecordId(employeeId) : employeeId;
  const subject = typeof employees[0]?.subject === "string"
    ? employees[0].subject
    : CLAIMS_RISK_EMPLOYEE_SUBJECT;
  const credentials = await root.query<{ secret?: unknown }>(
    "SELECT secret FROM employee_credential WHERE employee = $employee LIMIT 1",
    { employee: employeeRecord },
  );
  if (typeof credentials[0]?.secret === "string" && credentials[0].secret) {
    return { subject, secret: credentials[0].secret };
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
  return { subject, secret };
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

export async function listClaimsRiskEmployees(): Promise<ClaimsRiskEmployeeTarget[]> {
  const system = await getRootDatabaseSession("_system");
  const [workspaces] = await system.query<[{ db_name?: unknown }[]]>(
    'SELECT db_name FROM workspace WHERE status = "active"',
  );
  const targets: ClaimsRiskEmployeeTarget[] = [];
  for (const workspace of workspaces) {
    const database = typeof workspace.db_name === "string" ? workspace.db_name : "";
    if (!database) continue;
    const root = await getRootDatabaseSession(database);
    const provisioningSession: RootEmployeeProvisioningSession = {
      async query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>) {
        const [rows] = await root.query<[T[]]>(sql, params);
        return rows ?? [];
      },
    };
    const employee = await ensureClaimsRiskEmployee(provisioningSession);
    targets.push({ database, ...employee });
  }
  return targets;
}

export async function openClaimsRiskEmployeeStore(
  target: ClaimsRiskEmployeeTarget,
): Promise<EmployeeStoreWindow> {
  const session = new Surreal();
  await session.connect(env.SURREAL_URL, {
    reconnect: false,
    namespace: env.SURREAL_NS,
    database: target.database,
  });
  try {
    await session.signin({
      namespace: env.SURREAL_NS,
      database: target.database,
      access: "employee",
      variables: { subject: target.subject, pass: target.secret },
    });
  } catch (cause) {
    await session.close();
    throw cause;
  }
  const querySession: EmployeeQuerySession = {
    async query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>) {
      const results = await session.query<[T[]]>(sql, params);
      return results[0] ?? [];
    },
  };
  return {
    store: createSurrealClaimsRiskStore(querySession),
    async close() { await session.close(); },
  };
}

export async function runClaimsRiskReminderDispatch(
  deps: ClaimsRiskDispatchDeps = {},
): Promise<ClaimsRiskDispatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const targets = await (deps.listEmployees ?? listClaimsRiskEmployees)();
  const openStore = deps.openEmployeeStore ?? openClaimsRiskEmployeeStore;
  let completed = 0;
  let failed = 0;
  for (const target of targets) {
    let window: EmployeeStoreWindow | undefined;
    try {
      window = await openStore(target);
      await runDailyClaimsRiskCheck(window.store, { checkDate: shanghaiDateKey(now), checkedAt: now });
      completed += 1;
    } catch (cause) {
      failed += 1;
      console.error("[claims-risk] employee window failed", {
        database: target.database,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      await window?.close().catch(() => undefined);
    }
  }
  return { targets: targets.length, completed, failed };
}

export type ClaimsRiskDispatcherHandle = { stop(): Promise<void> };

export function startClaimsRiskReminderDispatcher(
  deps: ClaimsRiskDispatchDeps & { intervalMs?: number } = {},
): ClaimsRiskDispatcherHandle {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = runClaimsRiskReminderDispatch(deps)
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
    },
  };
}
