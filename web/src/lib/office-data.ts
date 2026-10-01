import { DateTime } from "surrealdb";
import { recordValueToString } from "./record-id";

/**
 * 办公室领域数据层（纯函数，无副作用、无响应式）：
 * 把浏览器直连查询 / LIVE 推送返回的原始行规整成 UI 消费的类型，
 * 并把任务、消息、报告和通知投影成一条排序稳定的活动时间线。
 *
 * RecordId / datetime 的边界转换只在这一层发生：入参是 SDK 返回的原始
 * `Record<string, unknown>`（record 字段是 RecordId 实例、datetime 是 SDK
 * `DateTime` 实例——连接未开 useNativeDates），出参一律 `table:id` 字符串与
 * ISO 时间。内存态不持有 SDK 对象，重复 upsert / 快照重查因此天然幂等可比。
 */

export type OfficeLifecycleStatus = "provisioning" | "active" | "paused" | "retired";

export type OfficeEmployee = {
  id: string;
  email: string;
  displayName: string;
  /** 虚拟员工岗位 key（office_role.key），真人为 null。 */
  roleKey: string | null;
  isVirtual: boolean;
  isAdmin: boolean;
  status: OfficeLifecycleStatus;
  lastActiveAt: string | null;
  createdAt: string;
};

export type OfficeTaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

export type OfficeTask = {
  id: string;
  goal: string;
  status: OfficeTaskStatus;
  assignerId: string | null;
  assigneeId: string | null;
  parentId: string | null;
  depth: number;
  dueAt: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OfficeMessage = {
  id: string;
  authorId: string | null;
  taskId: string | null;
  toId: string | null;
  body: string;
  createdAt: string;
};

export type OfficeReport = {
  id: string;
  authorId: string | null;
  toId: string | null;
  taskId: string | null;
  summary: string;
  nextSteps: string[];
  blockedBy: string | null;
  createdAt: string;
};

export type OfficeNotificationPurpose = "claims-risk" | "office-request" | "info";

export type OfficeNotification = {
  id: string;
  purpose: OfficeNotificationPurpose;
  title: string;
  body: string;
  fromEmployeeId: string | null;
  toUserId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
};

export type OfficeMeta = {
  goal: string;
  state: string;
  primaryContactId: string | null;
  updatedAt: string | null;
};

export type OfficeActivityKind = "task" | "message" | "report" | "notification";

/** 活动流统一卡片：由四张持久表投影而成，`id` 即原记录 id，天然去重键。 */
export type OfficeActivityItem = {
  id: string;
  kind: OfficeActivityKind;
  at: string;
  /** 同一时刻的次序补充键，保证排序全序稳定。 */
  sortKey: string;
  title: string;
  detail: string;
  taskId: string | null;
};

export type OfficeRow = Record<string, unknown>;

export type OfficeEmployeeStatus = OfficeLifecycleStatus;

function idString(value: unknown): string | null {
  const normalized = recordValueToString(value);
  return typeof normalized === "string" && normalized.length > 0 ? normalized : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoTime(value: unknown): string | null {
  // SDK 2.x 将 datetime 解码成 DateTime（Value 子类）而非 Date：先还原，否则
  // 所有时间字段被归一成 null（b09c87b1 QA 退回：活动时间全空、resolved_at 失效）。
  const date = value instanceof DateTime ? value.toDate() : value;
  if (date instanceof Date) {
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = recordValueToString(date);
  if (typeof raw !== "string" || !raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 时间排序键：缺失时间排最后（用空串即可——DESC 排序时空串在末尾）。 */
function timeOrEmpty(value: unknown): string {
  return isoTime(value) ?? "";
}

function parseVirtualProfile(row: OfficeRow): Record<string, unknown> {
  const profile = row.virtual_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : {};
}

export function normalizeEmployee(row: OfficeRow): OfficeEmployee {
  const profile = parseVirtualProfile(row);
  const rawStatus = text(profile.status);
  const status: OfficeLifecycleStatus =
    rawStatus === "active" || rawStatus === "paused" || rawStatus === "retired"
      ? rawStatus
      : "provisioning";
  return {
    id: idString(row.id) ?? "",
    email: text(row.email),
    displayName: text(row.display_name) || text(row.email) || "未命名成员",
    roleKey: text(profile.role_key) || null,
    isVirtual: row.kind === "virtual",
    isAdmin: row.is_admin === true,
    status,
    lastActiveAt: isoTime(profile.last_active_at),
    createdAt: timeOrEmpty(row.created_at),
  };
}

const TASK_STATUSES: readonly OfficeTaskStatus[] = ["open", "in_progress", "blocked", "done", "cancelled"];

export function normalizeTask(row: OfficeRow): OfficeTask {
  const rawStatus = text(row.status);
  const result = row.result;
  return {
    id: idString(row.id) ?? "",
    goal: text(row.goal),
    status: (TASK_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as OfficeTaskStatus)
      : "open",
    assignerId: idString(row.assigner),
    assigneeId: idString(row.assignee),
    parentId: idString(row.parent),
    depth: typeof row.depth === "number" && Number.isFinite(row.depth) ? row.depth : 0,
    dueAt: isoTime(row.due_at),
    resultSummary:
      result && typeof result === "object"
        ? text((result as Record<string, unknown>).summary) ||
          text((result as Record<string, unknown>).text) ||
          JSON.stringify(result).slice(0, 200)
        : null,
    createdAt: timeOrEmpty(row.created_at),
    updatedAt: timeOrEmpty(row.updated_at),
  };
}

export function normalizeMessage(row: OfficeRow): OfficeMessage {
  return {
    id: idString(row.id) ?? "",
    authorId: idString(row.author),
    taskId: idString(row.task),
    toId: idString(row.to),
    body: text(row.body),
    createdAt: timeOrEmpty(row.created_at),
  };
}

export function normalizeReport(row: OfficeRow): OfficeReport {
  const nextSteps = Array.isArray(row.next_steps)
    ? row.next_steps.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: idString(row.id) ?? "",
    authorId: idString(row.author),
    toId: idString(row.to),
    taskId: idString(row.task),
    summary: text(row.summary),
    nextSteps,
    blockedBy: text(row.blocked_by) || null,
    createdAt: timeOrEmpty(row.created_at),
  };
}

const PURPOSES: readonly OfficeNotificationPurpose[] = ["claims-risk", "office-request", "info"];

export function normalizeNotification(row: OfficeRow): OfficeNotification {
  const rawPurpose = text(row.purpose);
  const payload = row.payload;
  return {
    id: idString(row.id) ?? "",
    purpose: (PURPOSES as readonly string[]).includes(rawPurpose)
      ? (rawPurpose as OfficeNotificationPurpose)
      : "info",
    title: text(row.title) || "办公室通知",
    body: text(row.body),
    fromEmployeeId: idString(row.from_employee),
    toUserId: idString(row.to_user),
    taskId: idString(row.task),
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {},
    resolvedAt: isoTime(row.resolved_at),
    resolution: text(row.resolution) || null,
    createdAt: timeOrEmpty(row.created_at),
  };
}

export function normalizeOfficeMeta(row: OfficeRow): OfficeMeta {
  return {
    goal: text(row.goal),
    state: text(row.state) || "pending",
    primaryContactId: idString(row.primary_contact),
    updatedAt: isoTime(row.updated_at),
  };
}

const TASK_STATUS_LABELS: Record<OfficeTaskStatus, string> = {
  open: "待开始",
  in_progress: "进行中",
  blocked: "受阻",
  done: "已完成",
  cancelled: "已取消",
};

const NOTIFICATION_PURPOSE_LABELS: Record<OfficeNotificationPurpose, string> = {
  "claims-risk": "债权风险提醒",
  "office-request": "员工请求",
  info: "通知",
};

export function taskStatusLabel(status: OfficeTaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

export function notificationPurposeLabel(purpose: OfficeNotificationPurpose): string {
  return NOTIFICATION_PURPOSE_LABELS[purpose];
}

/**
 * 活动时间线投影：四类持久记录按发生时间倒序合并，同一时刻用记录 id 决胜，
 * 输出全序稳定；重复 LIVE / 重连重查只是按 id 覆盖，不产生重复卡片。
 */
export function projectActivity(input: {
  tasks: OfficeTask[];
  messages: OfficeMessage[];
  reports: OfficeReport[];
  notifications: OfficeNotification[];
}): OfficeActivityItem[] {
  const items: OfficeActivityItem[] = [];
  for (const task of input.tasks) {
    if (!task.id) continue;
    items.push({
      id: task.id,
      kind: "task",
      at: task.updatedAt || task.createdAt,
      sortKey: task.id,
      title: `任务${taskStatusLabel(task.status)}：${truncate(task.goal, 60)}`,
      detail: task.goal,
      taskId: task.id,
    });
  }
  for (const message of input.messages) {
    if (!message.id) continue;
    items.push({
      id: message.id,
      kind: "message",
      at: message.createdAt,
      sortKey: message.id,
      title: `消息：${truncate(message.body, 60)}`,
      detail: message.body,
      taskId: message.taskId,
    });
  }
  for (const report of input.reports) {
    if (!report.id) continue;
    items.push({
      id: report.id,
      kind: "report",
      at: report.createdAt,
      sortKey: report.id,
      title: `报告：${truncate(report.summary, 60)}`,
      detail: report.summary,
      taskId: report.taskId,
    });
  }
  for (const notification of input.notifications) {
    if (!notification.id) continue;
    items.push({
      id: notification.id,
      kind: "notification",
      at: notification.createdAt,
      sortKey: notification.id,
      title: `${notificationPurposeLabel(notification.purpose)}：${truncate(notification.title, 60)}`,
      detail: notification.body,
      taskId: notification.taskId,
    });
  }
  // 时间倒序、同刻按 id 升序：任何一次全量重查 / 增量 upsert 后重投影顺序一致。
  return items.sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? 1 : -1;
    return left.sortKey < right.sortKey ? -1 : 1;
  });
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
