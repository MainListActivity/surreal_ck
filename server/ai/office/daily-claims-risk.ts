export type DailyRunState = "acquired" | "completed";

export type ClaimsWorkbook = {
  id: string;
  name: string;
  sheets: Partial<Record<"creditors" | "materials" | "tasks", string>>;
};

export type RiskReminderType = "missing-material" | "due-within-seven-days" | "amount-anomaly";

export type RiskReminder = {
  dedupeKey: string;
  checkDate: string;
  checkedAt: Date;
  workbookId: string;
  workbookName: string;
  recordId: string;
  riskType: RiskReminderType;
  title: string;
  body: string;
  severity: "info" | "warning" | "urgent";
  matchedFields: Record<string, unknown>;
  rule: string;
};

export type ClaimsRiskStore = {
  beginDailyRun(checkDate: string): Promise<DailyRunState>;
  loadEnabledWorkbooks(): Promise<ClaimsWorkbook[]>;
  loadSheetRecords(tableName: string): Promise<Array<Record<string, unknown>>>;
  saveReminder(reminder: RiskReminder): Promise<boolean>;
  completeDailyRun(checkDate: string, checkedAt: Date): Promise<void>;
  failDailyRun(checkDate: string, cause: unknown): Promise<void>;
};

export type DailyClaimsRiskCheckResult = {
  status: "completed" | "already-completed" | "not-enabled";
  remindersCreated: number;
};

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function missingMaterialReminder(
  workbook: ClaimsWorkbook,
  record: Record<string, unknown>,
  input: { checkDate: string; checkedAt: Date },
): RiskReminder | null {
  if (record.is_missing !== true || record.id == null) return null;
  const recordId = String(record.id);
  const materialName = text(record.material_name, "未命名材料");
  const reviewNotes = typeof record.review_notes === "string" ? record.review_notes : undefined;
  return {
    dedupeKey: `${input.checkDate}|${workbook.id}|${recordId}|missing-material`,
    checkDate: input.checkDate,
    checkedAt: input.checkedAt,
    workbookId: workbook.id,
    workbookName: workbook.name,
    recordId,
    riskType: "missing-material",
    title: `材料缺失：${materialName}`,
    body: reviewNotes ? `${materialName}：${reviewNotes}` : `${materialName}被标记为缺失。`,
    severity: "warning",
    matchedFields: { is_missing: true, ...(reviewNotes ? { review_notes: reviewNotes } : {}) },
    rule: "证据材料记录的“是否缺失”为是",
  };
}

const CLOSED_TASK_STATUSES = new Set(["已完成", "已取消", "completed", "cancelled"]);

function dueSoonReminder(
  workbook: ClaimsWorkbook,
  record: Record<string, unknown>,
  input: { checkDate: string; checkedAt: Date },
): RiskReminder | null {
  if (record.id == null || CLOSED_TASK_STATUSES.has(String(record.status ?? ""))) return null;
  const dueDate = record.due_date instanceof Date ? record.due_date : new Date(String(record.due_date ?? ""));
  if (!Number.isFinite(dueDate.getTime())) return null;
  const start = new Date(`${input.checkDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (dueDate < start || dueDate > end) return null;
  const recordId = String(record.id);
  const taskName = text(record.task_name, "未命名待办");
  const status = text(record.status, "未完成");
  return {
    dedupeKey: `${input.checkDate}|${workbook.id}|${recordId}|due-within-seven-days`,
    checkDate: input.checkDate,
    checkedAt: input.checkedAt,
    workbookId: workbook.id,
    workbookName: workbook.name,
    recordId,
    riskType: "due-within-seven-days",
    title: `期限临近：${taskName}`,
    body: `${taskName}将在 ${dueDate.toISOString().slice(0, 10)} 截止，当前状态为“${status}”。`,
    severity: "urgent",
    matchedFields: { due_date: dueDate.toISOString(), status },
    rule: "未完成待办的截止日期在检查日起七天内",
  };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountAnomalyReminder(
  workbook: ClaimsWorkbook,
  record: Record<string, unknown>,
  input: { checkDate: string; checkedAt: Date },
): RiskReminder | null {
  if (record.id == null) return null;
  const declared = finiteNumber(record.declared_amount);
  const reviewed = finiteNumber(record.reviewed_amount);
  if (declared === null || reviewed === null) return null;
  const differenceRatio = declared > 0
    ? Math.round((Math.abs(reviewed - declared) / declared) * 10_000) / 10_000
    : null;
  if (reviewed <= declared && (differenceRatio === null || differenceRatio < 0.3)) return null;
  const recordId = String(record.id);
  const creditorName = text(record.creditor_name, "未命名债权人");
  return {
    dedupeKey: `${input.checkDate}|${workbook.id}|${recordId}|amount-anomaly`,
    checkDate: input.checkDate,
    checkedAt: input.checkedAt,
    workbookId: workbook.id,
    workbookName: workbook.name,
    recordId,
    riskType: "amount-anomaly",
    title: `金额异常：${creditorName}`,
    body: `${creditorName}申报金额为 ${declared}，审核金额为 ${reviewed}。`,
    severity: reviewed > declared ? "urgent" : "warning",
    matchedFields: {
      declared_amount: declared,
      reviewed_amount: reviewed,
      ...(differenceRatio === null ? {} : { difference_ratio: differenceRatio }),
    },
    rule: "审核金额超过申报金额，或两者差异达到申报金额的 30%",
  };
}

export async function runDailyClaimsRiskCheck(
  store: ClaimsRiskStore,
  input: { checkDate: string; checkedAt: Date },
): Promise<DailyClaimsRiskCheckResult> {
  const workbooks = await store.loadEnabledWorkbooks();
  if (workbooks.length === 0) {
    return { status: "not-enabled", remindersCreated: 0 };
  }
  const state = await store.beginDailyRun(input.checkDate);
  if (state === "completed") {
    return { status: "already-completed", remindersCreated: 0 };
  }

  try {
    let remindersCreated = 0;
    for (const workbook of workbooks) {
      const materialsTable = workbook.sheets.materials;
      if (materialsTable) {
        const records = await store.loadSheetRecords(materialsTable);
        for (const record of records) {
          const reminder = missingMaterialReminder(workbook, record, input);
          if (reminder && await store.saveReminder(reminder)) remindersCreated += 1;
        }
      }
      const tasksTable = workbook.sheets.tasks;
      if (tasksTable) {
        const records = await store.loadSheetRecords(tasksTable);
        for (const record of records) {
          const reminder = dueSoonReminder(workbook, record, input);
          if (reminder && await store.saveReminder(reminder)) remindersCreated += 1;
        }
      }
      const creditorsTable = workbook.sheets.creditors;
      if (creditorsTable) {
        const records = await store.loadSheetRecords(creditorsTable);
        for (const record of records) {
          const reminder = amountAnomalyReminder(workbook, record, input);
          if (reminder && await store.saveReminder(reminder)) remindersCreated += 1;
        }
      }
    }
    await store.completeDailyRun(input.checkDate, input.checkedAt);
    return { status: "completed", remindersCreated };
  } catch (cause) {
    await store.failDailyRun(input.checkDate, cause);
    throw cause;
  }
}
