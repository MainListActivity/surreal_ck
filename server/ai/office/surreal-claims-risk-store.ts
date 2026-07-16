import { StringRecordId } from "surrealdb";
import type {
  ClaimsRiskStore,
  ClaimsWorkbook,
  DailyRunState,
  RiskReminder,
} from "./daily-claims-risk";

export type EmployeeQuerySession = {
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
};

function recordString(value: unknown): string {
  return value == null ? "" : String(value);
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 500);
}

export function createSurrealClaimsRiskStore(session: EmployeeQuerySession): ClaimsRiskStore {
  let notificationOwner: StringRecordId | null | undefined;

  async function owner(): Promise<StringRecordId | null> {
    if (notificationOwner !== undefined) return notificationOwner;
    const rows = await session.query<{ id: unknown }>(
      'SELECT id FROM user WHERE kind = "human" AND is_admin = true AND disabled_at = NONE ORDER BY created_at ASC LIMIT 1',
    );
    notificationOwner = rows[0]?.id == null ? null : new StringRecordId(recordString(rows[0].id));
    return notificationOwner;
  }

  return {
    async beginDailyRun(checkDate: string): Promise<DailyRunState> {
      const rows = await session.query<{ status: string }>(
        `INSERT INTO risk_check_run {
          check_date: $checkDate,
          status: "running",
          started_at: time::now()
        }
        ON DUPLICATE KEY UPDATE
          status = IF status = "completed" { "completed" } ELSE { "running" },
          employee = fn::current_user(),
          started_at = IF status = "completed" { started_at } ELSE { time::now() },
          completed_at = IF status = "completed" { completed_at } ELSE { NONE },
          error_message = NONE
        RETURN AFTER`,
        { checkDate },
      );
      return rows[0]?.status === "completed" ? "completed" : "acquired";
    },

    async loadEnabledWorkbooks(): Promise<ClaimsWorkbook[]> {
      const workbooks = await session.query<{ id: unknown; name?: unknown }>(
        `SELECT id, name FROM workbook
         WHERE risk_reminders_enabled = true
           AND template.key = "bankruptcy-claims"`,
      );
      const result: ClaimsWorkbook[] = [];
      for (const workbook of workbooks) {
        const id = recordString(workbook.id);
        if (!id) continue;
        const sheets = await session.query<{ template_sheet_key?: unknown; table_name?: unknown }>(
          "SELECT template_sheet_key, table_name FROM sheet WHERE workbook = $workbook",
          { workbook: new StringRecordId(id) },
        );
        const mapped: ClaimsWorkbook["sheets"] = {};
        for (const sheet of sheets) {
          const key = String(sheet.template_sheet_key ?? "");
          const tableName = String(sheet.table_name ?? "");
          if ((key === "creditors" || key === "materials" || key === "tasks") && tableName) {
            mapped[key] = tableName;
          }
        }
        result.push({ id, name: String(workbook.name ?? "未命名工作簿"), sheets: mapped });
      }
      return result;
    },

    loadSheetRecords(tableName: string) {
      return session.query<Record<string, unknown>>("SELECT * FROM type::table($table)", { table: tableName });
    },

    async saveReminder(reminder: RiskReminder): Promise<boolean> {
      const toUser = await owner();
      if (!toUser) return false;
      await session.query(
        `INSERT INTO user_notification $content
         ON DUPLICATE KEY UPDATE dedupe_key = $input.dedupe_key
         RETURN AFTER`,
        {
          content: {
            dedupe_key: reminder.dedupeKey,
            to_user: toUser,
            workbook: new StringRecordId(reminder.workbookId),
            related_record: new StringRecordId(reminder.recordId),
            risk_type: reminder.riskType,
            title: reminder.title,
            body: reminder.body,
            severity: reminder.severity,
            requested_action: "查看命中数据并决定是否处理",
            matched_fields: reminder.matchedFields,
            rule: reminder.rule,
            checked_at: reminder.checkedAt,
          },
        },
      );
      return true;
    },

    async completeDailyRun(checkDate: string, checkedAt: Date): Promise<void> {
      await session.query(
        `UPDATE risk_check_run SET
           status = "completed",
           completed_at = $checkedAt,
           error_message = NONE
         WHERE check_date = $checkDate`,
        { checkDate, checkedAt },
      );
    },

    async failDailyRun(checkDate: string, cause: unknown): Promise<void> {
      await session.query(
        `UPDATE risk_check_run SET
           status = "failed",
           error_message = $message
         WHERE check_date = $checkDate`,
        { checkDate, message: errorMessage(cause) },
      );
    },
  };
}
