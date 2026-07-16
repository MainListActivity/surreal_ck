import type { AiContextSnapshot, RecordIdString } from "@surreal-ck/shared";
import type { SurrealConn } from "./surreal";
import { recordValueToString, toRecordId } from "./record-id";

export type RiskNotification = {
  id: string;
  workbookId: string;
  workbookName: string;
  recordId: string;
  riskType: "missing-material" | "due-within-seven-days" | "amount-anomaly";
  title: string;
  body: string;
  severity: "info" | "warning" | "urgent";
  matchedFields: Record<string, unknown>;
  rule: string;
  checkedAt: string;
  createdAt: string;
};

function stringRecord(value: unknown): string {
  return String(recordValueToString(value) ?? "");
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function normalizeNotification(row: Record<string, unknown>): RiskNotification {
  return {
    id: stringRecord(row.id),
    workbookId: stringRecord(row.workbook),
    workbookName: typeof row.workbook_name === "string" ? row.workbook_name : "未命名工作簿",
    recordId: stringRecord(row.related_record),
    riskType: row.risk_type as RiskNotification["riskType"],
    title: typeof row.title === "string" ? row.title : "风险提醒",
    body: typeof row.body === "string" ? row.body : "",
    severity: row.severity as RiskNotification["severity"],
    matchedFields: typeof row.matched_fields === "object" && row.matched_fields !== null
      ? { ...row.matched_fields as Record<string, unknown> }
      : {},
    rule: typeof row.rule === "string" ? row.rule : "",
    checkedAt: dateString(row.checked_at),
    createdAt: dateString(row.created_at),
  };
}

export async function loadRiskNotifications(conn: Pick<SurrealConn, "query">): Promise<RiskNotification[]> {
  const rows = await conn.query<Record<string, unknown>>(
    `SELECT id, workbook, workbook.name AS workbook_name, related_record,
      risk_type, title, body, severity, matched_fields, rule, checked_at, created_at
     FROM user_notification
     WHERE resolved_at = NONE
     ORDER BY created_at DESC`,
  );
  return rows.map(normalizeNotification);
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
