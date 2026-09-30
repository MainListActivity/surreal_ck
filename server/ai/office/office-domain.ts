import { createHash } from "node:crypto";
import { StringRecordId } from "surrealdb";
import type { TriggerSession } from "./employee-trigger-runtime";

/**
 * 办公室领域读写层（VO02）：handler 内全部经 TriggerSession（员工自身 RECORD
 * 会话）落库，root 不进入业务写路径。
 *
 * 幂等策略：append-only 表（office_message / office_report）FOR update 为 NONE，
 * 使用 INSERT IGNORE + 调用方给的确定性 record id——重放撞 id 时引擎静默跳过，
 * 不会触发 update 权限拒绝；office_task 同理用确定性 id 保证"同一逻辑对象只落
 * 一行"。同一员工的所有窗口在 runtime 里串行，直插不存在并发竞态；同触发重放
 * 另有 employee_effect 账本兜底。
 *
 * option 字段约定：绑参里的 JS null 会被引擎当 NULL 而非 NONE，option<T> 强转
 * 直接拒收——content 对象只放有值的键，缺省交给 schema DEFAULT/NONE。
 */

export const OFFICE_META_ID = "office_meta:office";
export const OFFICE_INITIAL_TASK_ID = "office_task:pm_initial";
export const OFFICE_MAX_DEPTH = 8;

export class OfficeDomainError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "OfficeDomainError";
    this.code = code;
  }
}

export type OfficeMeta = {
  goal: string;
  /** primary contact 的 user record id 字符串；未配置为 null。 */
  primaryContact: string | null;
  state: string;
};

type OfficeMetaRow = {
  goal?: unknown;
  primary_contact?: unknown;
  state?: unknown;
};

export async function readOfficeMeta(session: TriggerSession): Promise<OfficeMeta | null> {
  const [rows] = await session.query<[OfficeMetaRow[]]>(
    `SELECT goal, primary_contact, state FROM ${OFFICE_META_ID};`,
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    goal: typeof row.goal === "string" ? row.goal : "",
    primaryContact: row.primary_contact == null ? null : String(row.primary_contact),
    state: typeof row.state === "string" ? row.state : "pending",
  };
}

/** bootstrap 的前置条件：goal 非空且 primary_contact 已指到真人。 */
export function requireOfficeMeta(meta: OfficeMeta | null): OfficeMeta & { primaryContact: string } {
  if (!meta || !meta.goal.trim()) {
    throw new OfficeDomainError("office-goal-missing", "office_meta.goal 未保存");
  }
  if (!meta.primaryContact) {
    throw new OfficeDomainError("office-primary-contact-missing", "office_meta.primary_contact 未保存");
  }
  return meta as OfficeMeta & { primaryContact: string };
}

export type OfficeTaskRow = {
  id: string;
  goal: string;
  assigner: string;
  assignee: string;
  parent: string | null;
  depth: number;
  status: string;
  completion: string | null;
  brief: Record<string, unknown> | null;
};

type RawTaskRow = {
  id?: unknown;
  goal?: unknown;
  assigner?: unknown;
  assignee?: unknown;
  parent?: unknown;
  depth?: unknown;
  status?: unknown;
  completion?: unknown;
  brief?: unknown;
};

function mapTask(row: RawTaskRow): OfficeTaskRow {
  return {
    id: String(row.id),
    goal: typeof row.goal === "string" ? row.goal : "",
    assigner: String(row.assigner),
    assignee: String(row.assignee),
    parent: row.parent == null ? null : String(row.parent),
    depth: typeof row.depth === "number" ? row.depth : 0,
    status: typeof row.status === "string" ? row.status : "open",
    completion: typeof row.completion === "string" ? row.completion : null,
    brief: row.brief && typeof row.brief === "object" ? (row.brief as Record<string, unknown>) : null,
  };
}

export async function getOfficeTask(
  session: TriggerSession,
  taskId: string,
): Promise<OfficeTaskRow | null> {
  const [rows] = await session.query<[RawTaskRow[]]>(
    `SELECT id, goal, assigner, assignee, parent, depth, status, completion, brief
     FROM $task;`,
    { task: new StringRecordId(taskId) },
  );
  const row = rows?.[0];
  return row ? mapTask(row) : null;
}

export type TaskSpec = {
  goal: string;
  assignee: string;
  completion?: string;
  parent?: string;
  depth?: number;
  brief?: Record<string, unknown>;
};

/**
 * 幂等建任务：确定性 record id + INSERT IGNORE，重放撞 id 静默跳过。
 * 返回落库后的任务行（新建或既有）。
 */
export async function createOfficeTaskOnce(
  session: TriggerSession,
  taskId: string,
  spec: TaskSpec,
): Promise<OfficeTaskRow> {
  const content: Record<string, unknown> = {
    id: new StringRecordId(taskId),
    goal: spec.goal,
    assignee: new StringRecordId(spec.assignee),
    depth: spec.depth ?? 0,
  };
  if (spec.parent) content.parent = new StringRecordId(spec.parent);
  if (spec.completion !== undefined) content.completion = spec.completion;
  if (spec.brief !== undefined) content.brief = spec.brief;
  await session.query("INSERT IGNORE INTO office_task $content;", { content });
  const task = await getOfficeTask(session, taskId);
  if (!task) throw new OfficeDomainError("office-task-create-failed", taskId);
  return task;
}

/**
 * 有边界的委派：PM/员工在领域层先校验（assignee 存在且为 active 员工或真人、
 * depth 有界），再落 INSERT——数据库 ASSERT/状态守卫仍是最终权威，领域层负责
 * 给出结构化的可诊断拒绝原因而不是裸引擎错误。
 */
export async function delegateOfficeTask(
  session: TriggerSession,
  parentTask: OfficeTaskRow,
  input: { assignee: string; goal: string; completion?: string },
): Promise<{ task: OfficeTaskRow; assigneeKind: string }> {
  const depth = parentTask.depth + 1;
  if (depth > OFFICE_MAX_DEPTH) {
    throw new OfficeDomainError(
      "delegation-depth-exceeded",
      `parent ${parentTask.id} depth ${parentTask.depth}+1 > ${OFFICE_MAX_DEPTH}`,
    );
  }
  const [users] = await session.query<[{ kind?: unknown; status?: unknown }[]]>(
    `SELECT kind, virtual_profile.status AS status FROM $assignee;`,
    { assignee: new StringRecordId(input.assignee) },
  );
  const assignee = users?.[0];
  if (!assignee) {
    throw new OfficeDomainError("assignee-not-found", input.assignee);
  }
  const kind = typeof assignee.kind === "string" ? assignee.kind : "";
  const status = typeof assignee.status === "string" ? assignee.status : "";
  if (kind === "virtual" && status !== "active") {
    throw new OfficeDomainError("assignee-inactive", `${input.assignee} status=${status || "none"}`);
  }
  // 同一 parent 的一次委派收敛到同一行（确定性 id）。
  const childId = `office_task:sub_${parentTask.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const task = await createOfficeTaskOnce(session, childId, {
    goal: input.goal,
    assignee: input.assignee,
    completion: input.completion,
    parent: parentTask.id,
    depth,
  });
  return { task, assigneeKind: kind };
}

export type PostMessageInput = {
  /** 确定性 record id（如 office_message:pm_accept_pm_initial）。 */
  id: string;
  task?: string;
  to?: string;
  body: string;
};

export async function postOfficeMessage(
  session: TriggerSession,
  input: PostMessageInput,
): Promise<void> {
  const content: Record<string, unknown> = {
    id: new StringRecordId(input.id),
    body: input.body,
  };
  if (input.task) content.task = new StringRecordId(input.task);
  if (input.to) content.to = new StringRecordId(input.to);
  await session.query("INSERT IGNORE INTO office_message $content;", { content });
}

export type DeliverReportInput = {
  id: string;
  task: string;
  /** primary contact 的 user record id。 */
  to: string;
  summary: string;
  nextSteps?: string[];
  blockedBy?: string;
};

export async function deliverOfficeReport(
  session: TriggerSession,
  input: DeliverReportInput,
): Promise<void> {
  const content: Record<string, unknown> = {
    id: new StringRecordId(input.id),
    task: new StringRecordId(input.task),
    to: new StringRecordId(input.to),
    summary: input.summary,
  };
  if (input.nextSteps) content.next_steps = input.nextSteps;
  if (input.blockedBy) content.blocked_by = input.blockedBy;
  await session.query("INSERT IGNORE INTO office_report $content;", { content });
}

/** 推进任务状态；同值更新为空操作，终态守卫由 schema EVENT 兜底。 */
export async function setOfficeTaskStatus(
  session: TriggerSession,
  taskId: string,
  status: "in_progress" | "blocked" | "done" | "cancelled",
  result?: Record<string, unknown>,
): Promise<void> {
  const sets = result === undefined
    ? "status = $status"
    : "status = $status, result = $result";
  await session.query(
    `UPDATE $task SET ${sets} WHERE status != $status;`,
    { task: new StringRecordId(taskId), status, result },
  );
}

// ── 人类请求（VO03）：员工向收件人发结构化问题，答复经同一收件箱回流 ─────────

export type OfficeRequestInput = {
  /** 确定性 record id（officeRequestId 生成），重试收敛同一行。 */
  id: string;
  /** 去重键：与 record id 同源，dedupe_key 唯一索引兜底并发重复。 */
  dedupeKey: string;
  /** 目标收件人（真人 user record id）。 */
  to: string;
  /** 关联的 office_task record id。 */
  task?: string;
  /** 问题类型（free-text / confirm / choice），仅作呈现提示。 */
  questionType?: string;
  /** 提示内容（问题正文）。 */
  prompt: string;
  /** choice 类型的可选项。 */
  options?: string[];
  /** 发起请求的 trigger id 与窗口 run id（追溯关联，非安全语义）。 */
  requestTrigger?: string;
  runId?: string;
};

const OFFICE_REQUEST_TITLE: Record<string, string> = {
  "free-text": "员工向你提问",
  confirm: "员工请求确认",
  choice: "员工请你选择",
};

/** 人类请求的稳定 record id：同一任务同一问题的重试收敛到同一行。 */
export function officeRequestId(taskId: string, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 10);
  return `user_notification:ofreq_${taskId.replace(/[^a-zA-Z0-9_]/g, "_")}_${hash}`;
}

/**
 * 创建结构化人类请求：写入通用 user_notification（purpose=office-request），
 * 收件人是唯一可写终态的人；确定性 id + dedupe_key 让重试与并发投递收敛。
 * 发送者即 $auth（employee 会话），payload 携带问题与 run/trigger 追溯。
 */
export async function createOfficeRequest(
  session: TriggerSession,
  input: OfficeRequestInput,
): Promise<{ id: string; dedupeKey: string }> {
  const payload: Record<string, unknown> = {
    question_type: input.questionType ?? "free-text",
    prompt: input.prompt,
  };
  if (input.options?.length) payload.options = input.options;
  if (input.requestTrigger) payload.request_trigger = input.requestTrigger;
  if (input.runId) payload.run_id = input.runId;
  const content: Record<string, unknown> = {
    id: new StringRecordId(input.id),
    dedupe_key: input.dedupeKey,
    to_user: new StringRecordId(input.to),
    purpose: "office-request",
    title: OFFICE_REQUEST_TITLE[input.questionType ?? "free-text"] ?? "员工向你提问",
    body: input.prompt,
    severity: "info",
    payload,
  };
  if (input.task) content.task = new StringRecordId(input.task);
  // 撞 id 或撞 dedupe_key 都静默收敛；随后读回校验——权限拒绝不会伪装成成功。
  await session.query(
    `INSERT INTO user_notification $content
     ON DUPLICATE KEY UPDATE dedupe_key = $content.dedupe_key;`,
    { content },
  );
  const [rows] = await session.query<[{ id?: unknown }[]]>(
    `SELECT id FROM $request;`,
    { request: new StringRecordId(input.id) },
  );
  if (!rows?.[0]) throw new OfficeDomainError("office-request-create-failed", input.id);
  return { id: input.id, dedupeKey: input.dedupeKey };
}

export type OfficeRequestRow = {
  id: string;
  purpose: string | null;
  task: string | null;
  toUser: string | null;
  fromEmployee: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  answer: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};

type RawRequestRow = {
  id?: unknown;
  purpose?: unknown;
  task?: unknown;
  to_user?: unknown;
  from_employee?: unknown;
  resolved_at?: unknown;
  resolution?: unknown;
  answer?: unknown;
  payload?: unknown;
};

/**
 * 读回一条人类请求：员工会话只能读到 from_employee = 自己的行（schema select
 * 权限），收件人/admin 读自己收件箱的行；越权读到空集。
 */
export async function getOfficeRequest(
  session: TriggerSession,
  requestId: string,
): Promise<OfficeRequestRow | null> {
  const [rows] = await session.query<[RawRequestRow[]]>(
    `SELECT id, purpose, task, to_user, from_employee, resolved_at, resolution, answer, payload
     FROM $request;`,
    { request: new StringRecordId(requestId) },
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: String(row.id),
    purpose: typeof row.purpose === "string" ? row.purpose : null,
    task: row.task == null ? null : String(row.task),
    toUser: row.to_user == null ? null : String(row.to_user),
    fromEmployee: row.from_employee == null ? null : String(row.from_employee),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolution: typeof row.resolution === "string" ? row.resolution : null,
    answer: row.answer && typeof row.answer === "object" ? (row.answer as Record<string, unknown>) : null,
    payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null,
  };
}
