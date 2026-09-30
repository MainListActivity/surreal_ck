import { env } from "../../src/env";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { createCallerSession } from "../../src/ai/caller-session";
import { createEmployeeLifecycle, type EmployeeLifecycle } from "./employee-lifecycle";
import { createEmployeeRuntime, type EmployeeRuntime } from "./employee-runtime";

/**
 * 生产装配：进程内单例 employee runtime + 生命周期服务。
 * runtime 重启后 secret 缓存为空，warmup() 遍历 _system active workspace 回装；
 * startup.ts 的 shutdown 负责 stopEmployeeRuntime() 关掉所有员工连接。
 */

let sharedRuntime: EmployeeRuntime | null = null;

export function getEmployeeRuntime(): EmployeeRuntime {
  sharedRuntime ??= createEmployeeRuntime({
    surrealUrl: env.SURREAL_URL,
    namespace: env.SURREAL_NS,
    rootSession: (database) => getRootDatabaseSession(database),
    systemSession: () => getRootDatabaseSession("_system"),
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
