import { createHash } from "node:crypto";
import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { createCallerSession } from "../../src/ai/caller-session";
import {
  getEmployeeTriggerRuntime,
  createProductionEmployeeLifecycle,
  resolveWorkspaceBySlug,
} from "./employee-service";
import type { EmployeeLifecycle } from "./employee-lifecycle";
import type { EmployeeTriggerRuntime } from "./employee-trigger-runtime";
import {
  OFFICE_BOOTSTRAP_REASON,
  OFFICE_REQUEST_REASON,
  OFFICE_TASK_REASON,
  officeRequestTriggerKey,
  officeTaskTriggerKey,
  registerProjectManagerHandlers,
} from "./project-manager";
import { OFFICE_META_ID } from "./office-domain";

/**
 * 办公室 trigger adapter（VO02）：把办公室领域变化翻译成通用员工 trigger。
 *
 * 覆盖三类投递源：
 * - bootstrap：管理员保存 goal/primary_contact 后的一次性开岗动作——用通用
 *   lifecycle 幂等开岗项目经理（稳定 requestKey），再向 PM 投递稳定幂等键的
 *   office-bootstrap 触发；重复请求收敛到同一员工与同一触发。
 * - 新任务/任务状态：notifyOfficeTask 把"任务落到某员工名下"翻译成
 *   office-task 触发（payloadRef=任务 id，幂等键=office-task:<taskId>）；
 *   PM 在 handler 里创建/级联任务时也经同一键投递，不存在第二套投递通道。
 * - 定期 reconciliation：扫 workspace database 里仍开放的任务与已开岗员工，
 *   补投缺失触发并回收孤儿执行窗口，关闭"事件在 LIVE/投递间隙丢失"的缝。
 *
 * 边界：本模块不做 SIGNIN、不建会话池、不管租约/重试/预算——全部交给
 * EmployeeTriggerRuntime；root 只用于控制面枚举（workspace 索引、任务扫描），
 * 业务写一律发生在员工自身会话里。
 */

export type Queryable = {
  query<R extends unknown[] = unknown[]>(sql: string, params?: Record<string, unknown>): PromiseLike<R>;
};

type ClosableQueryable = Queryable & { close?(): Promise<unknown> };

/** 项目经理的稳定请求键：sha256(db:key) 派生身份，重试收敛同一员工。 */
export const OFFICE_MANAGER_REQUEST_KEY = "office-bootstrap:project-manager";
export const OFFICE_MANAGER_ROLE_KEY = "project-manager";
/** bootstrap 触发的幂等键：一个 workspace 只开一次岗。 */
export const OFFICE_BOOTSTRAP_KEY = "office-bootstrap";

/** 与 employee-lifecycle 同一推导：稳定 requestKey → 员工 record id。 */
export function officeManagerEmployeeId(database: string): string {
  const hash = createHash("sha256")
    .update(`${database}${OFFICE_MANAGER_REQUEST_KEY}`)
    .digest("hex")
    .slice(0, 24);
  return `user:ve_${hash}`;
}

// ── bootstrap ────────────────────────────────────────────────────────────

export type OfficeBootstrapDeps = {
  lifecycle: EmployeeLifecycle;
  triggerRuntime: Pick<EmployeeTriggerRuntime, "enqueue" | "start" | "registerHandler">;
  resolveWorkspace(slug: string): Promise<{ dbName: string } | null>;
  /** 调用者会话（读 office_meta 前置校验 + 置 active）；生产 = createCallerSession。 */
  callerSession(database: string, rawToken: string): Promise<ClosableQueryable>;
};

export type OfficeBootstrapResult =
  | {
      kind: "ok";
      employeeId: string;
      /** enqueue 的终态：completed / coalesced / waiting。 */
      outcome: string;
      triggerId: string;
      /** 初始任务的确定性 record id（触发完成时必已落库）。 */
      taskId: string;
    }
  | { kind: "workspace-not-found" }
  | { kind: "caller-denied" }
  | { kind: "meta-incomplete"; missing: string[] }
  | { kind: "provision-failed"; reason: string }
  | { kind: "trigger-failed"; error: string };

type MetaRow = { goal?: unknown; primary_contact?: unknown; state?: unknown; import_state?: unknown };

async function readMetaAsCaller(
  session: Queryable,
): Promise<{ goal: string; primaryContact: string | null; state: string; importState: string | null } | null> {
  const [rows] = await session.query<[MetaRow[]]>(
    `SELECT goal, primary_contact, state, import_state FROM ${OFFICE_META_ID};`,
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    goal: typeof row.goal === "string" ? row.goal : "",
    primaryContact: row.primary_contact == null ? null : String(row.primary_contact),
    state: typeof row.state === "string" ? row.state : "pending",
    importState: row.import_state == null ? null : String(row.import_state),
  };
}

/**
 * VO06 导入门禁：Excel 导入成功或管理员明确 skip 之前不允许开岗
 * （import_state 必须是 imported / skipped）；已 active 的办公室不受门禁影响
 * ——bootstrap 重放天然幂等，追加入口不得回头阻断既有办公室。
 */
function metaReadyForBootstrap(meta: { state: string; importState: string | null }): boolean {
  if (meta.state === "active") return true;
  return meta.importState === "imported" || meta.importState === "skipped";
}

/**
 * 一次性 office bootstrap：
 * 1. 解析 workspace → db（root 只读 _system 索引）；
 * 2. 调用者会话读 office_meta——goal/primary_contact 缺一即拒绝，不消耗触发键；
 * 3. lifecycle.provision 幂等开岗 PM（稳定 requestKey → 同一员工）；
 * 4. office_meta.state → active（管理员自己的写，不是员工代笔）；
 * 5. enqueue office-bootstrap 触发，幂等键恒定——同一 bootstrap 请求的任意
 *    重试都收敛到同一触发行。
 */
export async function bootstrapOffice(
  deps: OfficeBootstrapDeps,
  input: { slug: string; callerToken: string },
): Promise<OfficeBootstrapResult> {
  const workspace = await deps.resolveWorkspace(input.slug);
  if (!workspace) return { kind: "workspace-not-found" };
  const database = workspace.dbName;

  let caller: ClosableQueryable;
  try {
    caller = await deps.callerSession(database, input.callerToken);
  } catch {
    return { kind: "caller-denied" };
  }
  try {
    const meta = await readMetaAsCaller(caller);
    const missing: string[] = [];
    if (!meta?.goal.trim()) missing.push("goal");
    if (!meta?.primaryContact) missing.push("primary_contact");
    if (meta && !metaReadyForBootstrap(meta)) missing.push("import_state");
    if (missing.length) return { kind: "meta-incomplete", missing };

    const provisioned = await deps.lifecycle.provision({
      slug: input.slug,
      callerToken: input.callerToken,
      requestKey: OFFICE_MANAGER_REQUEST_KEY,
      displayName: "项目经理",
      roleKey: OFFICE_MANAGER_ROLE_KEY,
    });
    if (provisioned.kind !== "ok") {
      return { kind: "provision-failed", reason: provisioned.kind };
    }

    await caller.query(`UPDATE ${OFFICE_META_ID} SET state = "active" WHERE state != "active";`);

    registerProjectManagerHandlers(deps.triggerRuntime);
    deps.triggerRuntime.start();
    const result = await deps.triggerRuntime.enqueue({
      database,
      employeeId: provisioned.employee.id,
      reason: OFFICE_BOOTSTRAP_REASON,
      payloadRef: OFFICE_META_ID,
      chainDepth: 0,
      idempotencyKey: OFFICE_BOOTSTRAP_KEY,
    });
    if (result.outcome === "failed") {
      return { kind: "trigger-failed", error: result.error };
    }
    return {
      kind: "ok",
      employeeId: provisioned.employee.id,
      outcome: result.outcome,
      triggerId: result.triggerId,
      taskId: "office_task:pm_initial",
    };
  } finally {
    await caller.close?.().catch(() => undefined);
  }
}

export function createProductionOfficeBootstrap(): (
  input: { slug: string; callerToken: string },
) => Promise<OfficeBootstrapResult> {
  return (input) =>
    bootstrapOffice(
      {
        lifecycle: createProductionEmployeeLifecycle(),
        triggerRuntime: getEmployeeTriggerRuntime(),
        resolveWorkspace: resolveWorkspaceBySlug,
        callerSession: (_database, rawToken) => createCallerSession(rawToken),
      },
      input,
    );
}

// ── 新任务 / 任务状态投递 ────────────────────────────────────────────────

export type OfficeTaskDispatch = {
  database: string;
  /** 任务 assignee（员工 user record id）；runtime 会去 SIGNIN 该员工。 */
  assigneeId: string;
  taskId: string;
};

/** 把"任务落到某员工名下"翻译成通用触发；返回 runtime 的终态。 */
export async function notifyOfficeTask(
  runtime: Pick<EmployeeTriggerRuntime, "enqueue" | "start" | "registerHandler">,
  input: OfficeTaskDispatch,
) {
  registerProjectManagerHandlers(runtime);
  runtime.start();
  return runtime.enqueue({
    database: input.database,
    employeeId: input.assigneeId,
    reason: OFFICE_TASK_REASON,
    payloadRef: input.taskId,
    chainDepth: 0,
    idempotencyKey: officeTaskTriggerKey(input.taskId),
  });
}

// ── 人类请求终态唤醒（VO03） ────────────────────────────────────────────────

/**
 * 把"请求已在收件箱落终态"翻译成通用触发：幂等键 = office-request:<通知 id>，
 * 同一通知的重复唤醒（重复点击、重试、reconcile 补投）都收敛到同一触发。
 */
export async function notifyOfficeRequestResolved(
  runtime: Pick<EmployeeTriggerRuntime, "enqueue" | "start" | "registerHandler">,
  input: { database: string; notificationId: string; employeeId: string },
) {
  registerProjectManagerHandlers(runtime);
  runtime.start();
  return runtime.enqueue({
    database: input.database,
    employeeId: input.employeeId,
    reason: OFFICE_REQUEST_REASON,
    payloadRef: input.notificationId,
    chainDepth: 0,
    idempotencyKey: officeRequestTriggerKey(input.notificationId),
  });
}

export type OfficeRequestWakeDeps = {
  triggerRuntime: Pick<EmployeeTriggerRuntime, "enqueue" | "start" | "registerHandler">;
  resolveWorkspace(slug: string): Promise<{ dbName: string } | null>;
  /** 调用者会话：读通知时被表权限天然限定为收件人/admin 可见。 */
  callerSession(database: string, rawToken: string): Promise<ClosableQueryable>;
};

export type OfficeRequestWakeResult =
  | { kind: "ok"; outcome: string; triggerId: string }
  | { kind: "workspace-not-found" }
  | { kind: "caller-denied" }
  | { kind: "not-found" }
  | { kind: "not-request" }
  | { kind: "unresolved" }
  | { kind: "no-requester" }
  | { kind: "trigger-failed"; error: string };

type RequestRow = {
  id?: unknown;
  purpose?: unknown;
  resolved_at?: unknown;
  from_employee?: unknown;
};

/**
 * 唤醒编排：resolution 已在浏览器侧落库之后调用。
 * 1. 调用者会话读通知——非收件人/非 admin 读不到行，天然鉴权；
 * 2. 校验 purpose/终态/请求员工，未落终态不消耗触发键；
 * 3. 以稳定幂等键投递，恰好一次后续执行。
 */
export async function wakeResolvedOfficeRequest(
  deps: OfficeRequestWakeDeps,
  input: { slug: string; callerToken: string; notificationId: string },
): Promise<OfficeRequestWakeResult> {
  const workspace = await deps.resolveWorkspace(input.slug);
  if (!workspace) return { kind: "workspace-not-found" };
  const database = workspace.dbName;

  let caller: ClosableQueryable;
  try {
    caller = await deps.callerSession(database, input.callerToken);
  } catch {
    return { kind: "caller-denied" };
  }
  try {
    const [rows] = await caller.query<[RequestRow[]]>(
      `SELECT id, purpose, resolved_at, from_employee FROM $notification;`,
      { notification: new StringRecordId(input.notificationId) },
    );
    const row = rows?.[0];
    if (!row) return { kind: "not-found" };
    if (row.purpose !== "office-request") return { kind: "not-request" };
    if (row.resolved_at == null) return { kind: "unresolved" };
    const employee = row.from_employee == null ? "" : String(row.from_employee);
    if (!employee) return { kind: "no-requester" };

    const notificationId = String(row.id);
    const result = await notifyOfficeRequestResolved(deps.triggerRuntime, {
      database,
      notificationId,
      employeeId: employee,
    });
    if (result.outcome === "failed") {
      return { kind: "trigger-failed", error: result.error };
    }
    return { kind: "ok", outcome: result.outcome, triggerId: result.triggerId };
  } finally {
    await caller.close?.().catch(() => undefined);
  }
}

// ── 管理员发起的任务投递（VO06） ─────────────────────────────────────────
//
// onboarding 之后管理员在浏览器里直接创建 office_task（schema 约束
// assigner = fn::current_user()），但浏览器会话无权限写 employee_trigger——
// 投递必须经服务端把"任务落到员工名下"翻译成通用触发。本动作只做读校验 +
// 幂等投递（office-task:<taskId> 键恒定），不产生业务写。

export type OfficeTaskDispatchDeps = {
  triggerRuntime: Pick<EmployeeTriggerRuntime, "enqueue" | "start" | "registerHandler">;
  resolveWorkspace(slug: string): Promise<{ dbName: string } | null>;
  /** 调用者会话：读任务行（admin scope 由路由层先行把关）。 */
  callerSession(database: string, rawToken: string): Promise<ClosableQueryable>;
};

export type OfficeTaskDispatchResult =
  | { kind: "ok"; outcome: string; triggerId: string }
  | { kind: "workspace-not-found" }
  | { kind: "caller-denied" }
  | { kind: "task-not-found" }
  | { kind: "task-terminal"; status: string }
  | { kind: "assignee-not-virtual" }
  | { kind: "assignee-inactive"; status: string }
  | { kind: "trigger-failed"; error: string };

type DispatchTaskRow = {
  id?: unknown;
  status?: unknown;
  assignee?: unknown;
  assignee_kind?: unknown;
  assignee_status?: unknown;
};

export async function dispatchOfficeTask(
  deps: OfficeTaskDispatchDeps,
  input: { slug: string; callerToken: string; taskId: string },
): Promise<OfficeTaskDispatchResult> {
  const workspace = await deps.resolveWorkspace(input.slug);
  if (!workspace) return { kind: "workspace-not-found" };
  const database = workspace.dbName;

  let caller: ClosableQueryable;
  try {
    caller = await deps.callerSession(database, input.callerToken);
  } catch {
    return { kind: "caller-denied" };
  }
  try {
    const [rows] = await caller.query<[DispatchTaskRow[]]>(
      `SELECT id, status, assignee,
        assignee.kind AS assignee_kind,
        assignee.virtual_profile.status AS assignee_status
       FROM $task;`,
      { task: new StringRecordId(input.taskId) },
    );
    const task = rows?.[0];
    if (!task) return { kind: "task-not-found" };
    const status = typeof task.status === "string" ? task.status : "";
    if (status === "done" || status === "cancelled") {
      return { kind: "task-terminal", status };
    }
    if (task.assignee_kind !== "virtual") return { kind: "assignee-not-virtual" };
    const assigneeStatus = typeof task.assignee_status === "string" ? task.assignee_status : "";
    if (assigneeStatus !== "active") {
      return { kind: "assignee-inactive", status: assigneeStatus || "none" };
    }
    const assigneeId = task.assignee == null ? "" : String(task.assignee);
    if (!assigneeId) return { kind: "assignee-not-virtual" };

    const result = await notifyOfficeTask(deps.triggerRuntime, {
      database,
      assigneeId,
      taskId: String(task.id),
    });
    if (result.outcome === "failed") {
      return { kind: "trigger-failed", error: result.error };
    }
    return { kind: "ok", outcome: result.outcome, triggerId: result.triggerId };
  } finally {
    await caller.close?.().catch(() => undefined);
  }
}

export function createProductionOfficeTaskDispatch(): (
  input: { slug: string; callerToken: string; taskId: string },
) => Promise<OfficeTaskDispatchResult> {
  return (input) =>
    dispatchOfficeTask(
      {
        triggerRuntime: getEmployeeTriggerRuntime(),
        resolveWorkspace: resolveWorkspaceBySlug,
        callerSession: (_database, rawToken) => createCallerSession(rawToken),
      },
      input,
    );
}

export function createProductionOfficeRequestWake(): (
  input: { slug: string; callerToken: string; notificationId: string },
) => Promise<OfficeRequestWakeResult> {
  return (input) =>
    wakeResolvedOfficeRequest(
      {
        triggerRuntime: getEmployeeTriggerRuntime(),
        resolveWorkspace: resolveWorkspaceBySlug,
        callerSession: (_database, rawToken) => createCallerSession(rawToken),
      },
      input,
    );
}

// ── 定期 reconciliation ──────────────────────────────────────────────────

export type OfficeReconcileResult = {
  database: string;
  employees: number;
  dispatched: number;
  coalesced: number;
  failed: number;
};

/**
 * 单 workspace 的领域 reconciliation（root 只做控制面读）：
 * 1. office_meta 缺 goal/primary_contact → 该 workspace 尚未 onboarding，跳过；
 * 2. PM 记录存在且 active → 回收其孤儿触发 + 补投 bootstrap 触发（同幂等键，
 *    已完成即 coalesced）；
 * 3. 扫所有"分给 active 虚拟员工且未终态"的任务 → 按 office-task:<id> 幂等补投。
 */
export async function reconcileOfficeWorkspace(deps: {
  runtime: EmployeeTriggerRuntime;
  root: Queryable;
  database: string;
}): Promise<OfficeReconcileResult> {
  const { runtime, root, database } = deps;
  const summary: OfficeReconcileResult = {
    database,
    employees: 0,
    dispatched: 0,
    coalesced: 0,
    failed: 0,
  };

  const [metaRows] = await root.query<[{ goal?: unknown; primary_contact?: unknown }[]]>(
    `SELECT goal, primary_contact FROM ${OFFICE_META_ID};`,
  );
  const meta = metaRows?.[0];
  const ready =
    typeof meta?.goal === "string" && meta.goal.trim() !== "" && meta.primary_contact != null;
  if (!ready) return summary;

  const [employees] = await root.query<[{ id?: unknown }[]]>(
    `SELECT id FROM user WHERE kind = "virtual" AND virtual_profile.status = "active";`,
  );
  const activeEmployees = (employees ?? [])
    .map((row) => (row.id == null ? "" : String(row.id)))
    .filter(Boolean);
  summary.employees = activeEmployees.length;

  const managerId = officeManagerEmployeeId(database);
  if (activeEmployees.includes(managerId)) {
    await runtime.reconcile({ database, employeeId: managerId }).catch(() => undefined);
    const boot = await runtime
      .enqueue({
        database,
        employeeId: managerId,
        reason: OFFICE_BOOTSTRAP_REASON,
        payloadRef: OFFICE_META_ID,
        chainDepth: 0,
        idempotencyKey: OFFICE_BOOTSTRAP_KEY,
      })
      .catch(() => null);
    if (boot?.outcome === "completed" || boot?.outcome === "waiting") summary.dispatched += 1;
    else if (boot?.outcome === "coalesced") summary.coalesced += 1;
    else summary.failed += 1;
  }

  const [tasks] = await root.query<[{ id?: unknown; assignee?: unknown }[]]>(
    `SELECT id, assignee FROM office_task
      WHERE status INSIDE ["open", "in_progress", "blocked"]
        AND assignee.kind = "virtual"
        AND assignee.virtual_profile.status = "active";`,
  );
  for (const row of tasks ?? []) {
    const taskId = row.id == null ? "" : String(row.id);
    const assignee = row.assignee == null ? "" : String(row.assignee);
    if (!taskId || !assignee) continue;
    // 同键已完成的投递返回 coalesced，不产生重复执行。
    const result = await notifyOfficeTask(runtime, { database, assigneeId: assignee, taskId })
      .catch(() => null);
    if (!result) summary.failed += 1;
    else if (result.outcome === "completed" || result.outcome === "waiting") summary.dispatched += 1;
    else if (result.outcome === "coalesced") summary.coalesced += 1;
    else summary.failed += 1;
    await runtime.reconcile({ database, employeeId: assignee }).catch(() => undefined);
  }

  // VO03 补投缝：resolution 已落库但唤醒丢失（浏览器/服务在提交与投递间崩溃）
  // 的 office-request——同幂等键再投，已完成即 coalesced，收件人不需要重新回答。
  const [resolved] = await root.query<[{ id?: unknown; from_employee?: unknown }[]]>(
    `SELECT id, from_employee FROM user_notification
      WHERE purpose = "office-request" AND resolved_at != NONE
        AND from_employee.kind = "virtual";`,
  );
  for (const row of resolved ?? []) {
    const notificationId = row.id == null ? "" : String(row.id);
    const employee = row.from_employee == null ? "" : String(row.from_employee);
    if (!notificationId || !employee) continue;
    const result = await notifyOfficeRequestResolved(runtime, {
      database,
      notificationId,
      employeeId: employee,
    }).catch(() => null);
    if (!result) summary.failed += 1;
    else if (result.outcome === "completed" || result.outcome === "waiting") summary.dispatched += 1;
    else if (result.outcome === "coalesced") summary.coalesced += 1;
    else summary.failed += 1;
  }
  return summary;
}

async function listActiveWorkspaceDatabases(): Promise<string[]> {
  const system = await getRootDatabaseSession("_system");
  const [rows] = await system.query<[{ db_name?: unknown }[]]>(
    'SELECT db_name FROM workspace WHERE status = "active";',
  );
  return (rows ?? [])
    .map((row) => (typeof row.db_name === "string" ? row.db_name : ""))
    .filter(Boolean);
}

export type OfficeReconcilerHandle = { stop(): Promise<void> };

/**
 * 生产周期 reconciliation：扫所有 active workspace 补投缺失触发、回收孤儿窗口。
 * 失败只记日志不抛出——下一轮 tick 继续收敛。
 */
export function startOfficeReconciler(
  deps: {
    intervalMs?: number;
    triggerRuntime?: EmployeeTriggerRuntime;
    listDatabases?: () => Promise<string[]>;
    rootSession?: (database: string) => Promise<Queryable>;
    onError?: (database: string, cause: unknown) => void;
  } = {},
): OfficeReconcilerHandle {
  const runtime = deps.triggerRuntime ?? getEmployeeTriggerRuntime();
  registerProjectManagerHandlers(runtime);
  runtime.start();
  const listDatabases = deps.listDatabases ?? listActiveWorkspaceDatabases;
  const rootSession = deps.rootSession ?? ((database: string) => getRootDatabaseSession(database));
  const onError =
    deps.onError ??
    ((database, cause) =>
      console.warn("[office] reconcile failed", {
        database,
        message: cause instanceof Error ? cause.message : String(cause),
      }));

  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      for (const database of await listDatabases()) {
        await reconcileOfficeWorkspace({
          runtime,
          root: await rootSession(database),
          database,
        }).catch((cause) => onError(database, cause));
      }
    })()
      .catch((cause) => onError("_system", cause))
      .finally(() => {
        running = null;
      });
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
