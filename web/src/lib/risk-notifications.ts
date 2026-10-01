import type { AiContextSnapshot, RecordIdString } from "@surreal-ck/shared";
import type { SurrealConn } from "./surreal";
import { recordValueToString, toRecordId } from "./record-id";
import { api as defaultHcApi } from "./api";

export type NotificationPurpose = "claims-risk" | "office-request" | "info";

export type OfficeRequestAction = "answered" | "rejected" | "cancelled";

export type RiskNotification = {
  id: string;
  workbookId: string;
  workbookName: string;
  recordId: string;
  riskType: "missing-material" | "due-within-seven-days" | "amount-anomaly" | null;
  title: string;
  body: string;
  severity: "info" | "warning" | "urgent";
  matchedFields: Record<string, unknown>;
  rule: string;
  checkedAt: string;
  createdAt: string;
  /** 通知用途；缺省 claims-risk（存量行无 purpose 字段也按此呈现）。 */
  purpose: NotificationPurpose;
  /** office-request：发起员工 / 关联任务 / 结构化问题载荷。 */
  fromEmployee: string;
  taskId: string;
  questionType: string;
  options: string[];
  /** 终态：resolved_at / resolution / answer 三件套同读，便于 UI 与审计一致。 */
  resolvedAt: string;
  resolution: string;
  answerAction: OfficeRequestAction | null;
  answerText: string;
};

function stringRecord(value: unknown): string {
  return String(recordValueToString(value) ?? "");
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

const NOTIFICATION_PURPOSES = new Set<NotificationPurpose>(["claims-risk", "office-request", "info"]);
const REQUEST_ACTIONS = new Set<OfficeRequestAction>(["answered", "rejected", "cancelled"]);

function normalizeNotification(row: Record<string, unknown>): RiskNotification {
  const payload = typeof row.payload === "object" && row.payload !== null
    ? row.payload as Record<string, unknown>
    : {};
  const answer = typeof row.answer === "object" && row.answer !== null
    ? row.answer as Record<string, unknown>
    : null;
  const purpose = NOTIFICATION_PURPOSES.has(row.purpose as NotificationPurpose)
    ? row.purpose as NotificationPurpose
    : "claims-risk";
  return {
    id: stringRecord(row.id),
    workbookId: stringRecord(row.workbook),
    workbookName: typeof row.workbook_name === "string" ? row.workbook_name : "未命名工作簿",
    recordId: stringRecord(row.related_record),
    riskType: (row.risk_type as RiskNotification["riskType"]) ?? null,
    title: typeof row.title === "string" ? row.title : "风险提醒",
    body: typeof row.body === "string" ? row.body : "",
    severity: row.severity as RiskNotification["severity"],
    matchedFields: typeof row.matched_fields === "object" && row.matched_fields !== null
      ? { ...row.matched_fields as Record<string, unknown> }
      : {},
    rule: typeof row.rule === "string" ? row.rule : "",
    checkedAt: dateString(row.checked_at),
    createdAt: dateString(row.created_at),
    purpose,
    fromEmployee: stringRecord(row.from_employee),
    taskId: stringRecord(row.task),
    questionType: typeof payload.question_type === "string" ? payload.question_type : "free-text",
    options: Array.isArray(payload.options)
      ? payload.options.filter((o): o is string => typeof o === "string")
      : [],
    resolvedAt: dateString(row.resolved_at),
    resolution: typeof row.resolution === "string" ? row.resolution : "",
    answerAction: answer && REQUEST_ACTIONS.has(answer.action as OfficeRequestAction)
      ? answer.action as OfficeRequestAction
      : null,
    answerText: answer && typeof answer.text === "string" ? answer.text : "",
  };
}

export async function loadRiskNotifications(conn: Pick<SurrealConn, "query">): Promise<RiskNotification[]> {
  // 收件箱仍是单一 user_notification 视图：未终态的全部列出（债权提醒语义不变）；
  // 人类请求额外带上已终态行——答复/拒绝/取消的落库结果要在收件箱里可检查。
  const rows = await conn.query<Record<string, unknown>>(
    `SELECT id, workbook, workbook.name AS workbook_name, related_record,
      risk_type, title, body, severity, matched_fields, rule, checked_at, created_at,
      purpose, task, from_employee, payload, answer, resolution, resolved_at
     FROM user_notification
     WHERE resolved_at = NONE OR purpose = "office-request"
     ORDER BY created_at DESC`,
  );
  return rows.map(normalizeNotification);
}

/**
 * 收件箱数据通道：LIVE 推送刷新 + 断线重连后补一次快照。
 *
 * SDK 的 managed live 订阅在 connected 时会自动重注册 LIVE，但服务器不重放
 * 断开窗口内的变更——只在 connected（此时会话已恢复）再读一次快照才能让
 * 收件箱收敛到数据库真相。`refresh` 由调用方提供（重新加载并渲染快照）；
 * 返回的清理函数摘除 LIVE 订阅与 connected 监听。
 */
export function watchNotificationInbox(
  conn: Pick<SurrealConn, "liveTable" | "subscribe">,
  refresh: () => void,
): () => void {
  let disposed = false;
  let stopLive: (() => void) | undefined;
  void conn.liveTable("user_notification", () => refresh()).then((stop) => {
    if (disposed) stop();
    else stopLive = stop;
  }).catch(() => undefined);
  const offConnected = conn.subscribe("connected", () => refresh());
  return () => {
    disposed = true;
    stopLive?.();
    offConnected();
  };
}

const REQUEST_ACTION_LABELS: Record<OfficeRequestAction, string> = {
  answered: "已答复",
  rejected: "已拒绝",
  cancelled: "已取消",
};

export type OfficeRequestResolution =
  | { status: "resolved" }
  | { status: "already-resolved"; answerAction: OfficeRequestAction | null; resolution: string }
  | { status: "not-visible" };

/**
 * 提交人类请求终态（浏览器直连）：WHERE resolved_at = NONE 让首个提交成为唯一
 * 写入者；终态守卫兜底并发改写。写不到行时读回区分"已被解决"（幂等成功）
 * 与"通知不可见"（越权/不存在，诚实报错）。成功后由调用方唤醒请求员工。
 */
export async function resolveOfficeRequest(
  conn: Pick<SurrealConn, "query">,
  id: string,
  input: { action: OfficeRequestAction; text?: string },
): Promise<OfficeRequestResolution> {
  const text = input.text?.trim() ?? "";
  const updated = await conn.query<Record<string, unknown>>(
    `UPDATE $notification SET
       answer = $answer,
       resolution = $resolution,
       resolved_at = time::now()
     WHERE resolved_at = NONE
     RETURN AFTER;`,
    {
      notification: toRecordId(id),
      answer: {
        action: input.action,
        text,
        at: new Date().toISOString(),
      },
      resolution: text || REQUEST_ACTION_LABELS[input.action],
    },
  );
  if (updated.length > 0) return { status: "resolved" };
  const current = await conn.query<Record<string, unknown>>(
    `SELECT resolved_at, answer, resolution FROM $notification;`,
    { notification: toRecordId(id) },
  );
  const row = current[0];
  if (row && row.resolved_at != null) {
    const answer = typeof row.answer === "object" && row.answer !== null
      ? row.answer as Record<string, unknown>
      : null;
    return {
      status: "already-resolved",
      answerAction: answer && REQUEST_ACTIONS.has(answer.action as OfficeRequestAction)
        ? answer.action as OfficeRequestAction
        : null,
      resolution: typeof row.resolution === "string" ? row.resolution : "",
    };
  }
  return { status: "not-visible" };
}

type WakeEndpoint = {
  $post(input: { param: { slug: string; notificationId: string } }): Promise<Response>;
};
// client 是 hc<AppType> 实例（lib/api 导出的 api 或 createApiClient().api）；
// 其 .api 对应 AppType 里的 /api 路由段，缺了这一层 URL 会少掉 /api 前缀（VO03 QA 退回缺陷）。
type WakeClient = { api: { workspaces: Record<string, { office: { requests: Record<string, { wake: WakeEndpoint }> } }> } };

const defaultApi = defaultHcApi;

/**
 * 唤醒请求员工：resolution 已落库后调用后端端点，服务端以稳定幂等键投递
 * office-request-resolved 触发。重复调用安全（同键收敛），失败必须如实抛出
 * 供 UI 呈现"待重试"——不能把没送到的唤醒显示成成功。
 */
export async function wakeOfficeRequest(
  slug: string,
  notificationId: string,
  client: unknown = defaultApi,
): Promise<{ outcome: string }> {
  const api = client as WakeClient;
  const res = await api.api.workspaces[":slug"].office.requests[":notificationId"].wake.$post({
    param: { slug, notificationId: encodeURIComponent(notificationId) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`唤醒失败（${res.status}）${detail ? `：${detail.slice(0, 120)}` : ""}`);
  }
  const body = await res.json() as { outcome?: string };
  return { outcome: typeof body.outcome === "string" ? body.outcome : "queued" };
}

export async function resolveRiskNotification(
  conn: Pick<SurrealConn, "updateRecord">,
  id: string,
  resolution: string,
  resolvedAt = new Date(),
): Promise<void> {
  const message = resolution.trim();
  if (!message) throw new Error("处理说明不能为空");
  await conn.updateRecord(id, { resolution: message, resolved_at: resolvedAt });
}

export function buildRiskReminderAiContext(notification: RiskNotification): AiContextSnapshot {
  return {
    route: { screen: "notification", workbookId: notification.workbookId },
    workbook: {
      id: notification.workbookId as RecordIdString,
      name: notification.workbookName,
    },
    sheet: null,
    selectedRow: {
      id: notification.recordId as RecordIdString,
      label: notification.title,
      visibleValues: {
        ...notification.matchedFields,
        rule: notification.rule,
        checked_at: notification.checkedAt,
      },
    },
    contextHint: `${notification.workbookName} / ${notification.title}`,
  };
}

export async function resolveRiskNotificationTarget(
  conn: Pick<SurrealConn, "query">,
  input: { workbookId: string; recordId: string },
): Promise<{ workbookId: string; sheetId: string; recordId: string } | null> {
  const separator = input.recordId.indexOf(":");
  const tableName = separator > 0 ? input.recordId.slice(0, separator) : "";
  if (!tableName) return null;
  const rows = await conn.query<Record<string, unknown>>(
    "SELECT id FROM sheet WHERE workbook = $workbook AND table_name = $tableName LIMIT 1",
    { workbook: toRecordId(input.workbookId), tableName },
  );
  const sheetId = stringRecord(rows[0]?.id);
  return sheetId ? { ...input, sheetId } : null;
}

export type ClaimsReminderSetting = {
  workbookId: string;
  workbookName: string;
  enabled: boolean;
};

export async function loadClaimsReminderSettings(
  conn: Pick<SurrealConn, "query">,
): Promise<ClaimsReminderSetting[]> {
  const rows = await conn.query<Record<string, unknown>>(
    `SELECT id, name, risk_reminders_enabled FROM workbook
     WHERE template.key = "bankruptcy-claims"
     ORDER BY name ASC`,
  );
  return rows.map((row) => ({
    workbookId: stringRecord(row.id),
    workbookName: typeof row.name === "string" ? row.name : "未命名工作簿",
    enabled: row.risk_reminders_enabled === true,
  }));
}

export async function setClaimsReminderEnabled(
  conn: Pick<SurrealConn, "updateRecord">,
  workbookId: string,
  enabled: boolean,
): Promise<void> {
  await conn.updateRecord(workbookId, { risk_reminders_enabled: enabled });
}
