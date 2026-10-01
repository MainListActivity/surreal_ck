import { env } from "../../src/env";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { createCallerSession } from "../../src/ai/caller-session";
import { createEmployeeLifecycle, type EmployeeLifecycle } from "./employee-lifecycle";
import { createEmployeeRuntime, type EmployeeRuntime } from "./employee-runtime";
import {
  createEmployeeTriggerRuntime,
  type EmployeeRuntimeMetrics,
  type EmployeeTriggerRuntime,
} from "./employee-trigger-runtime";
import { createMastraEmployeeDriver } from "./employee-mastra-runner";
import {
  createEmployeeRuntimeSupervisor,
  type EmployeeRuntimeSupervisor,
  type EmployeeStartupProgress,
} from "./employee-supervisor";
import { registerQaProbeHandler } from "./qa-probe";

/**
 * 生产装配：进程内单例 employee runtime + 生命周期服务 + 启动监督。
 * runtime 重启后 secret 缓存为空，supervisor.start() 先 warmup 回装凭证，
 * 再有界并发 reconcile 全部 active workspace 的 active 员工；startup.ts 的
 * shutdown 负责 stopEmployeeTriggerRuntime()（限时 drain+ abort）与
 * stopEmployeeRuntime()（关掉所有员工连接）。
 */

let sharedRuntime: EmployeeRuntime | null = null;

export function getEmployeeRuntime(): EmployeeRuntime {
  sharedRuntime ??= createEmployeeRuntime({
    surrealUrl: env.SURREAL_URL,
    namespace: env.SURREAL_NS,
    renewAfterMs: env.EMPLOYEE_SESSION_RENEW_AFTER_SEC * 1000,
    rootSession: (database) => getRootDatabaseSession(database),
    systemSession: () => getRootDatabaseSession("_system"),
    // D1 返工：生命周期关闭/换代次会话时同步通知 trigger runtime——丢弃
    // lane 会话缓存并中止在途窗口（pause/retire 与窗口竞态的收敛入口）。
    onSessionClosed: (database, employeeId) =>
      sharedTriggerRuntime?.invalidateSession({ database, employeeId }),
  });
  return sharedRuntime;
}

export async function warmupEmployeeRuntime(): Promise<void> {
  await getEmployeeRuntime().warmup();
}

export async function stopEmployeeRuntime(): Promise<void> {
  const runtime = sharedRuntime;
  sharedRuntime = null;
  await runtime?.stop();
}

let sharedTriggerRuntime: EmployeeTriggerRuntime | null = null;

/** 进程内单例持久化触发 runtime（VER3/VER4）：会话走 employee runtime，durable run 走 Mastra driver。 */
export function getEmployeeTriggerRuntime(): EmployeeTriggerRuntime {
  sharedTriggerRuntime ??= createEmployeeTriggerRuntime({
    sessions: getEmployeeRuntime(),
    driver: createMastraEmployeeDriver,
    shutdownDeadlineMs: env.EMPLOYEE_RUNTIME_SHUTDOWN_DEADLINE_MS,
    abortGraceMs: env.EMPLOYEE_SHUTDOWN_ABORT_GRACE_MS,
  });
  // qa-probe 诊断 handler 常驻共享单例：内部投递口随时可用，不依赖 dispatcher 启动顺序。
  registerQaProbeHandler(sharedTriggerRuntime);
  return sharedTriggerRuntime;
}

export async function stopEmployeeTriggerRuntime(options?: { deadlineMs?: number }): Promise<void> {
  const runtime = sharedTriggerRuntime;
  sharedTriggerRuntime = null;
  sharedSupervisor = null;
  await runtime?.stop(options);
}

// ── 启动监督与运维观测（VER06）───────────────────────────────────────────

let sharedSupervisor: EmployeeRuntimeSupervisor | null = null;

/** _system workspace 索引 → active database 名。 */
async function listActiveWorkspaceDatabases(): Promise<string[]> {
  const system = await getRootDatabaseSession("_system");
  const [rows] = await system.query<[{ db_name?: unknown }[]]>(
    'SELECT db_name FROM workspace WHERE status = "active";',
  );
  return (rows ?? [])
    .map((row) => (typeof row.db_name === "string" ? row.db_name : ""))
    .filter(Boolean);
}

/** 单 workspace database 内的 active 虚拟员工 user id（root 只读枚举）。 */
async function listActiveEmployeesInDatabase(database: string): Promise<string[]> {
  const root = await getRootDatabaseSession(database);
  const [rows] = await root.query<[{ id?: unknown }[]]>(
    'SELECT id FROM user WHERE kind = "virtual" AND virtual_profile.status = "active";',
  );
  return (rows ?? [])
    .map((row) => (row.id == null ? "" : String(row.id)))
    .filter(Boolean);
}

export function getEmployeeSupervisor(): EmployeeRuntimeSupervisor {
  sharedSupervisor ??= createEmployeeRuntimeSupervisor({
    sessions: getEmployeeRuntime(),
    runtime: getEmployeeTriggerRuntime(),
    listWorkspaces: listActiveWorkspaceDatabases,
    listActiveEmployees: listActiveEmployeesInDatabase,
    concurrency: env.EMPLOYEE_STARTUP_RECONCILE_CONCURRENCY,
  });
  return sharedSupervisor;
}

/**
 * 进程启动监督：回装凭证 + 分批 reconcile。失败不阻塞启动（计数与
 * lastError 留在 progress 里），调用方以 void 驱动。
 */
export async function startEmployeeSupervision(): Promise<void> {
  try {
    await getEmployeeSupervisor().start();
  } catch (cause) {
    console.warn("[office] employee supervision failed", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** 运维健康/容量快照：runtime 指标 + 启动进度；只有计数与标识符，无凭证。 */
export function employeeRuntimeHealth(): EmployeeRuntimeMetrics & {
  startup: EmployeeStartupProgress;
} {
  return {
    ...getEmployeeTriggerRuntime().metrics(),
    startup: getEmployeeSupervisor().progress(),
  };
}

/** slug → active workspace db_name（root 只读 _system 索引）。 */
export async function resolveWorkspaceBySlug(slug: string): Promise<{ dbName: string } | null> {
  const system = await getRootDatabaseSession("_system");
  const [rows] = await system.query<[{ db_name?: unknown }[]]>(
    'SELECT db_name FROM workspace WHERE slug = $slug AND status = "active" LIMIT 1;',
    { slug },
  );
  const dbName = rows?.[0]?.db_name;
  return typeof dbName === "string" && dbName ? { dbName } : null;
}

export function createProductionEmployeeLifecycle(): EmployeeLifecycle {
  return createEmployeeLifecycle({
    resolveWorkspace: resolveWorkspaceBySlug,
    callerSession: (_database, rawToken) => createCallerSession(rawToken),
    rootSession: (database) => getRootDatabaseSession(database),
    runtime: getEmployeeRuntime(),
  });
}
