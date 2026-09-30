import type { EmployeeRuntime } from "./employee-runtime";
import type { EmployeeTriggerRuntime } from "./employee-trigger-runtime";

/**
 * 员工 runtime 启动监督（VER06）：进程启动后
 *   1. warmup 凭证缓存（枚举 active workspace → employee_credential，不开会话）；
 *   2. 分批 reconcile：有界并发遍历每个 active workspace 的 active 员工，
 *      回收其 pending / 过期 lease 的触发（进程重启/崩溃的兜底恢复路径；
 *      LIVE/实时通知永远只是提示，持久化队列才是事实来源）。
 *
 * 单条 reconcile 失败只计数不中断批次；进度经 progress() 暴露给运维端点。
 * start() 幂等：并发/重复调用返回同一个进行中的任务。
 */

export type EmployeeStartupProgress = {
  state: "idle" | "warmup" | "reconcile" | "done" | "failed";
  workspacesTotal: number;
  workspacesDone: number;
  /** 已扫描到的 active 员工总数（枚举完成才定值）。 */
  employeesTotal: number;
  employeesReconciled: number;
  employeesFailed: number;
  /** 当前在途 reconcile 数（<= concurrency）。 */
  inFlight: number;
  warmup: { databases: number; credentials: number } | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};

export type EmployeeRuntimeSupervisor = {
  /** warmup + 分批 reconcile；重复/并发调用共享同一次启动。 */
  start(): Promise<EmployeeStartupProgress>;
  progress(): EmployeeStartupProgress;
};

const idleProgress = (): EmployeeStartupProgress => ({
  state: "idle",
  workspacesTotal: 0,
  workspacesDone: 0,
  employeesTotal: 0,
  employeesReconciled: 0,
  employeesFailed: 0,
  inFlight: 0,
  warmup: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
});

function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}

export function createEmployeeRuntimeSupervisor(deps: {
  runtime: Pick<EmployeeTriggerRuntime, "reconcile">;
  /** 可选：先回装凭证缓存（EmployeeRuntime.warmup）。 */
  sessions?: Pick<EmployeeRuntime, "warmup">;
  /** 枚举 active workspace 的 database 名（生产走 _system 索引）。 */
  listWorkspaces: () => Promise<readonly string[]>;
  /** 枚举一个 workspace database 内的 active 员工 user record id。 */
  listActiveEmployees: (database: string) => Promise<readonly string[]>;
  /** reconcile 并发上限；默认 4。 */
  concurrency?: number;
  now?: () => Date;
}): EmployeeRuntimeSupervisor {
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  const now = deps.now ?? (() => new Date());
  const progress = idleProgress();
  let task: Promise<EmployeeStartupProgress> | null = null;

  const log = (event: string, fields: Record<string, unknown>) => {
    console.warn(`[employee-supervisor] ${event}`, fields);
  };

  async function run(): Promise<EmployeeStartupProgress> {
    progress.state = "warmup";
    progress.startedAt = now().toISOString();
    try {
      if (deps.sessions) {
        progress.warmup = await deps.sessions.warmup();
      }
      progress.state = "reconcile";
      const workspaces = await deps.listWorkspaces();
      progress.workspacesTotal = workspaces.length;

      // 先枚举出全部 (database, employeeId) 任务，再有界并发执行——
      // 枚举本身串行（root 会话是共享连接，内部已有并发控制）。
      const jobs: Array<{ database: string; employeeId: string }> = [];
      for (const database of workspaces) {
        try {
          const employees = await deps.listActiveEmployees(database);
          for (const employeeId of employees) jobs.push({ database, employeeId });
        } catch (cause) {
          progress.lastError = message(cause);
          log("list-employees-failed", { database, message: progress.lastError });
        }
        progress.workspacesDone += 1;
      }
      progress.employeesTotal = jobs.length;

      // 有界并发池：worker 从共享游标取任务，单条失败计数后继续。
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor];
          cursor += 1;
          progress.inFlight += 1;
          try {
            await deps.runtime.reconcile(job);
            progress.employeesReconciled += 1;
          } catch (cause) {
            progress.employeesFailed += 1;
            progress.lastError = message(cause);
            log("reconcile-failed", {
              database: job.database,
              employeeId: job.employeeId,
              message: progress.lastError,
            });
          } finally {
            progress.inFlight -= 1;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
      );
      progress.state = "done";
    } catch (cause) {
      progress.state = "failed";
      progress.lastError = message(cause);
      log("startup-failed", { message: progress.lastError });
    } finally {
      progress.finishedAt = now().toISOString();
    }
    return { ...progress };
  }

  return {
    start() {
      task ??= run();
      return task;
    },
    progress() {
      return { ...progress };
    },
  };
}
