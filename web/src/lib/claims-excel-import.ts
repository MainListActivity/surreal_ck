/**
 * 11.1 债权对账：管理人 Excel 名册 / 账面导入。
 * 校验规则见 docs/claims-reconciliation/excel-templates.md 与 data-model.md。
 * 成功行写入 SCHEMAFULL 表；失败行带 Excel 行号拒绝（表头为第 1 行，首条数据为第 2 行）。
 * 部分成功：合法行写入，非法行不写入。
 */
import * as XLSX from "xlsx";
import type { GridColumnDef, RecordIdString } from "@surreal-ck/shared/dto";
import { gridColumnToStoredDef } from "@surreal-ck/shared/field-schema";
import { omitNullishSurrealFields } from "@surreal-ck/shared/surreal-values";
import type { SurrealConn } from "./surreal";
import { toRecordId } from "./record-id";

export const CREDITOR_ROSTER_TABLE = "creditor_roster";
export const ENTERPRISE_LEDGER_TABLE = "enterprise_ledger";
export const CLAIMS_WORKBOOK_NAME = "债权对账";
export const ROSTER_SHEET_LABEL = "债权人名册";
export const LEDGER_SHEET_LABEL = "企业账面";

export const ROSTER_TEMPLATE_PATH = "/claims-reconciliation/creditor-roster.xlsx";
export const LEDGER_TEMPLATE_PATH = "/claims-reconciliation/enterprise-ledger.xlsx";

export const ROSTER_EXPECTED_HEADERS = [
  "主体类型",
  "名称",
  "唯一识别码",
  "对接联系人",
  "联系方式",
] as const;

export const LEDGER_EXPECTED_HEADERS = [
  "唯一识别码",
  "本金",
  "账面利息",
  "合同引用",
  "备注",
] as const;

export type ClaimsSubjectType = "enterprise" | "person";

export type ClaimsImportRejectedRow = {
  rowNumber: number;
  field: string;
  reason: string;
};

export type CreditorRosterRecord = {
  subject_type: ClaimsSubjectType;
  name: string;
  identity_code: string;
  contact_name: string | null;
  contact_channel: string | null;
};

export type EnterpriseLedgerRecord = {
  identity_code: string;
  principal: number;
  book_interest: number;
  contract_ref: string | null;
  note: string | null;
};

export type RosterValidateResult = {
  accepted: Array<{ rowNumber: number; record: CreditorRosterRecord }>;
  rejected: ClaimsImportRejectedRow[];
};

export type LedgerValidateResult = {
  accepted: Array<{ rowNumber: number; record: EnterpriseLedgerRecord }>;
  rejected: ClaimsImportRejectedRow[];
};

export type ClaimsImportWriteResult = {
  importedCount: number;
  rejected: ClaimsImportRejectedRow[];
  workbookId: RecordIdString | null;
  rosterSheetId: RecordIdString | null;
  ledgerSheetId: RecordIdString | null;
};

export const ROSTER_COLUMN_DEFS: GridColumnDef[] = [
  { key: "subject_type", label: "主体类型", fieldType: "single_select", required: true, options: ["enterprise", "person"] },
  { key: "name", label: "名称", fieldType: "text", required: true },
  { key: "identity_code", label: "唯一识别码", fieldType: "text", required: true },
  { key: "contact_name", label: "对接联系人", fieldType: "text", required: false },
  { key: "contact_channel", label: "联系方式", fieldType: "text", required: false },
];

export const LEDGER_COLUMN_DEFS: GridColumnDef[] = [
  { key: "identity_code", label: "唯一识别码", fieldType: "text", required: true },
  { key: "principal", label: "本金", fieldType: "decimal", required: true, constraints: { min: 0 } },
  { key: "book_interest", label: "账面利息", fieldType: "decimal", required: true, constraints: { min: 0 } },
  { key: "contract_ref", label: "合同引用", fieldType: "text", required: false },
  { key: "note", label: "备注", fieldType: "text", required: false },
];

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).trim();
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[￥¥$€£,\s]/gu, "").trim();
  if (!cleaned) return null;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

function mapSubjectType(raw: string): ClaimsSubjectType | null {
  const value = raw.trim();
  if (value === "企业" || value === "enterprise") return "enterprise";
  if (value === "个人" || value === "person") return "person";
  return null;
}

function sheetRows(data: ArrayBuffer | Uint8Array, expectedSheetName: string): string[][] {
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.find((name) => name === expectedSheetName)
    ?? workbook.SheetNames[0];
  if (!sheetName) return [];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return [];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });
  return raw.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    return cells.map(cellText);
  });
}

function assertHeaders(headerRow: string[] | undefined, expected: readonly string[]): string | null {
  if (!headerRow || headerRow.every((cell) => !cell)) {
    return "缺少表头行";
  }
  for (let i = 0; i < expected.length; i += 1) {
    if ((headerRow[i] ?? "").trim() !== expected[i]) {
      return `表头第 ${i + 1} 列应为「${expected[i]}」，实际为「${(headerRow[i] ?? "").trim() || "空"}」`;
    }
  }
  return null;
}

function isBlankDataRow(cells: string[], width: number): boolean {
  for (let i = 0; i < width; i += 1) {
    if ((cells[i] ?? "").trim()) return false;
  }
  return true;
}

/**
 * 纯函数：校验名册行。`existingIdentityCodes` 为库内已有识别码（导入前快照）。
 * 文件内重复与库内冲突均拒绝并带行号。
 */
export function validateRosterRows(
  rows: string[][],
  existingIdentityCodes: ReadonlySet<string> = new Set(),
): RosterValidateResult {
  const headerIssue = assertHeaders(rows[0], ROSTER_EXPECTED_HEADERS);
  if (headerIssue) {
    return {
      accepted: [],
      rejected: [{ rowNumber: 1, field: "header", reason: headerIssue }],
    };
  }

  const accepted: RosterValidateResult["accepted"] = [];
  const rejected: ClaimsImportRejectedRow[] = [];
  const seenInFile = new Set<string>();

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const cells = rows[index] ?? [];
    if (isBlankDataRow(cells, ROSTER_EXPECTED_HEADERS.length)) continue;

    const subjectRaw = cells[0] ?? "";
    const name = (cells[1] ?? "").trim();
    const identityCode = (cells[2] ?? "").trim();
    const contactName = optionalText(cells[3] ?? "");
    const contactChannel = optionalText(cells[4] ?? "");

    const subjectType = mapSubjectType(subjectRaw);
    if (!subjectType) {
      rejected.push({ rowNumber, field: "subject_type", reason: "主体类型须为「企业」或「个人」" });
      continue;
    }
    if (!name) {
      rejected.push({ rowNumber, field: "name", reason: "名称不能为空" });
      continue;
    }
    if (!identityCode) {
      rejected.push({ rowNumber, field: "identity_code", reason: "唯一识别码不能为空" });
      continue;
    }
    if (seenInFile.has(identityCode)) {
      rejected.push({ rowNumber, field: "identity_code", reason: "唯一识别码在本文件名册内重复" });
      continue;
    }
    if (existingIdentityCodes.has(identityCode)) {
      rejected.push({ rowNumber, field: "identity_code", reason: "唯一识别码与名册已有行冲突" });
      continue;
    }
    if (subjectType === "enterprise" && !contactName) {
      rejected.push({ rowNumber, field: "contact_name", reason: "企业行必须填写对接联系人" });
      continue;
    }

    seenInFile.add(identityCode);
    accepted.push({
      rowNumber,
      record: {
        subject_type: subjectType,
        name,
        identity_code: identityCode,
        contact_name: contactName,
        contact_channel: contactChannel,
      },
    });
  }

  return { accepted, rejected };
}

/**
 * 纯函数：校验账面行。`rosterIdentityCodes` = 名册（库内 ∪ 本批已接受）识别码集合。
 */
export function validateLedgerRows(
  rows: string[][],
  rosterIdentityCodes: ReadonlySet<string>,
): LedgerValidateResult {
  const headerIssue = assertHeaders(rows[0], LEDGER_EXPECTED_HEADERS);
  if (headerIssue) {
    return {
      accepted: [],
      rejected: [{ rowNumber: 1, field: "header", reason: headerIssue }],
    };
  }

  const accepted: LedgerValidateResult["accepted"] = [];
  const rejected: ClaimsImportRejectedRow[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const cells = rows[index] ?? [];
    if (isBlankDataRow(cells, LEDGER_EXPECTED_HEADERS.length)) continue;

    const identityCode = (cells[0] ?? "").trim();
    const principalRaw = cells[1] ?? "";
    const interestRaw = cells[2] ?? "";
    const contractRef = optionalText(cells[3] ?? "");
    const note = optionalText(cells[4] ?? "");

    if (!identityCode) {
      rejected.push({ rowNumber, field: "identity_code", reason: "唯一识别码不能为空" });
      continue;
    }
    if (!rosterIdentityCodes.has(identityCode)) {
      rejected.push({ rowNumber, field: "identity_code", reason: "唯一识别码不在名册中" });
      continue;
    }
    const principal = parseAmount(principalRaw);
    if (principal == null) {
      rejected.push({ rowNumber, field: "principal", reason: "本金须为非负数字" });
      continue;
    }
    if (principal < 0) {
      rejected.push({ rowNumber, field: "principal", reason: "本金不能为负数" });
      continue;
    }
    const bookInterest = parseAmount(interestRaw);
    if (bookInterest == null) {
      rejected.push({ rowNumber, field: "book_interest", reason: "账面利息须为非负数字" });
      continue;
    }
    if (bookInterest < 0) {
      rejected.push({ rowNumber, field: "book_interest", reason: "账面利息不能为负数" });
      continue;
    }

    accepted.push({
      rowNumber,
      record: {
        identity_code: identityCode,
        principal,
        book_interest: bookInterest,
        contract_ref: contractRef,
        note,
      },
    });
  }

  return { accepted, rejected };
}

export function parseRosterWorkbook(data: ArrayBuffer | Uint8Array): string[][] {
  return sheetRows(data, "名册");
}

export function parseLedgerWorkbook(data: ArrayBuffer | Uint8Array): string[][] {
  return sheetRows(data, "账面");
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ClaimsWorkbookRefs = {
  workbookId: RecordIdString;
  rosterSheetId: RecordIdString;
  ledgerSheetId: RecordIdString;
};

/**
 * 确保「债权对账」工作簿存在，且两张 sheet.table_name 分别指向 SCHEMAFULL 表。
 * 不 DEFINE SCHEMALESS 实体表（表已由 050 迁移创建）。
 */
export async function ensureClaimsWorkbook(
  conn: SurrealConn,
  generateKey: () => string = randomKey,
): Promise<ClaimsWorkbookRefs> {
  const existingSheets = await conn.query<{
    id: unknown;
    workbook: unknown;
    table_name: string;
  }>(
    `SELECT id, workbook, table_name FROM sheet WHERE table_name INSIDE [$roster, $ledger]`,
    { roster: CREDITOR_ROSTER_TABLE, ledger: ENTERPRISE_LEDGER_TABLE },
  );

  const rosterSheet = existingSheets.find((row) => row.table_name === CREDITOR_ROSTER_TABLE);
  const ledgerSheet = existingSheets.find((row) => row.table_name === ENTERPRISE_LEDGER_TABLE);

  if (rosterSheet && ledgerSheet) {
    const workbookId = String(rosterSheet.workbook);
    return {
      workbookId: workbookId as RecordIdString,
      rosterSheetId: String(rosterSheet.id) as RecordIdString,
      ledgerSheetId: String(ledgerSheet.id) as RecordIdString,
    };
  }

  const wbKey = generateKey();
  const workbookId = `workbook:${wbKey}` as RecordIdString;
  const rosterSheetId = (rosterSheet
    ? String(rosterSheet.id)
    : `sheet:${generateKey()}`) as RecordIdString;
  const ledgerSheetId = (ledgerSheet
    ? String(ledgerSheet.id)
    : `sheet:${generateKey()}`) as RecordIdString;

  const existingWorkbookId = rosterSheet
    ? String(rosterSheet.workbook)
    : ledgerSheet
      ? String(ledgerSheet.workbook)
      : null;

  // workbook / sheet id 来自受控 hex key，与 workbooks.ts 建簿同口径直接写入标识符。
  const wb = existingWorkbookId ?? workbookId;
  const statements: string[] = [];
  const bindings: Record<string, unknown> = {};

  if (!existingWorkbookId) {
    statements.push(
      `CREATE ${workbookId} CONTENT { name: $claimsWorkbookName, last_opened_sheet: ${rosterSheetId} };`,
    );
    bindings.claimsWorkbookName = CLAIMS_WORKBOOK_NAME;
  }
  if (!rosterSheet) {
    statements.push(
      `CREATE ${rosterSheetId} CONTENT { workbook: ${wb}, label: $rosterLabel, table_name: $rosterTable, column_defs: $rosterColumns };`,
    );
    bindings.rosterLabel = ROSTER_SHEET_LABEL;
    bindings.rosterTable = CREDITOR_ROSTER_TABLE;
    bindings.rosterColumns = ROSTER_COLUMN_DEFS.map(gridColumnToStoredDef);
  }
  if (!ledgerSheet) {
    statements.push(
      `CREATE ${ledgerSheetId} CONTENT { workbook: ${wb}, label: $ledgerLabel, table_name: $ledgerTable, column_defs: $ledgerColumns };`,
    );
    bindings.ledgerLabel = LEDGER_SHEET_LABEL;
    bindings.ledgerTable = ENTERPRISE_LEDGER_TABLE;
    bindings.ledgerColumns = LEDGER_COLUMN_DEFS.map(gridColumnToStoredDef);
  }

  if (statements.length) {
    await conn.query(
      `BEGIN TRANSACTION;\n${statements.join("\n")}\nCOMMIT TRANSACTION;`,
      bindings,
    );
  }

  return {
    workbookId: (existingWorkbookId ?? workbookId) as RecordIdString,
    rosterSheetId,
    ledgerSheetId,
  };
}

async function loadExistingIdentityCodes(conn: SurrealConn): Promise<Set<string>> {
  const rows = await conn.query<{ identity_code: string }>(
    `SELECT identity_code FROM type::table($tb)`,
    { tb: CREDITOR_ROSTER_TABLE },
  );
  return new Set(rows.map((row) => String(row.identity_code ?? "").trim()).filter(Boolean));
}

export async function importCreditorRoster(
  conn: SurrealConn,
  data: ArrayBuffer | Uint8Array,
  options: { generateKey?: () => string } = {},
): Promise<ClaimsImportWriteResult> {
  const rows = parseRosterWorkbook(data);
  const existing = await loadExistingIdentityCodes(conn);
  const validated = validateRosterRows(rows, existing);

  for (const item of validated.accepted) {
    await conn.createRecord(
      CREDITOR_ROSTER_TABLE,
      omitNullishSurrealFields({
        subject_type: item.record.subject_type,
        name: item.record.name,
        identity_code: item.record.identity_code,
        contact_name: item.record.contact_name,
        contact_channel: item.record.contact_channel,
      }),
    );
  }

  const refs = await ensureClaimsWorkbook(conn, options.generateKey);
  return {
    importedCount: validated.accepted.length,
    rejected: validated.rejected,
    workbookId: refs.workbookId,
    rosterSheetId: refs.rosterSheetId,
    ledgerSheetId: refs.ledgerSheetId,
  };
}

export async function importEnterpriseLedger(
  conn: SurrealConn,
  data: ArrayBuffer | Uint8Array,
  options: { generateKey?: () => string } = {},
): Promise<ClaimsImportWriteResult> {
  const rows = parseLedgerWorkbook(data);
  const rosterCodes = await loadExistingIdentityCodes(conn);
  const validated = validateLedgerRows(rows, rosterCodes);

  for (const item of validated.accepted) {
    await conn.createRecord(
      ENTERPRISE_LEDGER_TABLE,
      omitNullishSurrealFields({
        identity_code: item.record.identity_code,
        principal: item.record.principal,
        book_interest: item.record.book_interest,
        contract_ref: item.record.contract_ref,
        note: item.record.note,
      }),
    );
  }

  const refs = await ensureClaimsWorkbook(conn, options.generateKey);
  return {
    importedCount: validated.accepted.length,
    rejected: validated.rejected,
    workbookId: refs.workbookId,
    rosterSheetId: refs.rosterSheetId,
    ledgerSheetId: refs.ledgerSheetId,
  };
}

/** 测试与 UI 共用：把行号错误格式化成可读摘要。 */
export function formatClaimsImportSummary(result: Pick<ClaimsImportWriteResult, "importedCount" | "rejected">): string {
  if (result.rejected.length === 0) {
    return `成功导入 ${result.importedCount} 行`;
  }
  const samples = result.rejected
    .slice(0, 5)
    .map((row) => `第 ${row.rowNumber} 行（${row.field}）：${row.reason}`)
    .join("；");
  const more = result.rejected.length > 5 ? `等共 ${result.rejected.length} 处拒绝` : "";
  return `成功 ${result.importedCount} 行，拒绝 ${result.rejected.length} 行。${samples}${more ? `；${more}` : ""}`;
}

export function buildRosterXlsx(rows: Array<Array<string | number>>): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...ROSTER_EXPECTED_HEADERS],
    ...rows,
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "名册");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

export function buildLedgerXlsx(rows: Array<Array<string | number>>): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...LEDGER_EXPECTED_HEADERS],
    ...rows,
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "账面");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

/** 供 DataTableRuntime / 编辑器打开 sheet 时定位。 */
export function claimsSheetIdForTable(
  refs: ClaimsWorkbookRefs,
  tableName: string,
): RecordIdString | null {
  if (tableName === CREDITOR_ROSTER_TABLE) return refs.rosterSheetId;
  if (tableName === ENTERPRISE_LEDGER_TABLE) return refs.ledgerSheetId;
  return null;
}

export function toClaimsRecordId(id: string): ReturnType<typeof toRecordId> {
  return toRecordId(id);
}
