import { StringRecordId } from "surrealdb";
import type { SurrealConn } from "../surreal";
import type { RosterPollAgenda } from "./roster-polls";

export type RosterArchiveSheets = { attendanceSheet: string; voteSheet: string };
export type RosterArchiveConfig = Partial<RosterArchiveSheets> & {
  weightField?: string;
  defaults?: { agenda?: RosterPollAgenda[]; weightField?: string };
};
export type RosterWorkbookSheet = {
  id: unknown; label: string; workbook_name?: string; table_name: string;
  column_defs?: { key: string; label?: string; field_type?: string }[];
};

export const archiveFields = {
  attendance: {
    meeting_id: "text", subject_id: "text", name: "text", attended: "checkbox",
    duration_ms: "number", segments: "text", timeline: "text",
  },
  vote: {
    meeting_id: "text", poll_id: "text", title: "text", version: "text", option: "text",
    label: "text", count: "number", weight: "number", ballots: "text",
  },
};
export type ArchiveKind = keyof typeof archiveFields;
type ArchiveTable = { label: string; fields: string[]; rows: Record<string, unknown>[] };

export function isRosterArchiveSheet(sheet: RosterWorkbookSheet, kind: ArchiveKind): boolean {
  return Object.entries(archiveFields[kind]).every(([key, type]) =>
    sheet.column_defs?.some((column) => column.key === key && column.field_type === type));
}

export async function readRosterArchive(
  conn: Pick<SurrealConn, "query">, meeting: string, sheetId: string, kind: ArchiveKind,
): Promise<ArchiveTable> {
  if (!sheetId.startsWith("sheet:")) throw new Error("归档数据表标识无效。");
  const [sheet] = await conn.query<Pick<RosterWorkbookSheet, "table_name">>(
    "SELECT table_name FROM $sheet", { sheet: new StringRecordId(sheetId) },
  );
  if (!sheet?.table_name) throw new Error("找不到对应的归档数据表。");
  const rows: ArchiveTable["rows"] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await conn.query<Record<string, unknown>>(
      "SELECT * FROM type::table($table) WHERE meeting_id = $meeting ORDER BY id LIMIT $limit START $offset",
      { table: sheet.table_name, meeting, limit, offset },
    );
    rows.push(...page);
    if (page.length < limit) break;
  }
  return { label: kind === "attendance" ? "会议签到" : "表决统计", fields: Object.keys(archiveFields[kind]), rows };
}

function archiveText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown): string {
  let text = archiveText(value);
  if (typeof value === "string" && (/^[\s\uFEFF]*[=+@－＝＋＠-]/u.test(text) || /^[\t\r\n]/u.test(text))) {
    text = "'" + text;
  }
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function buildRosterArchiveCsv(table: ArchiveTable): string {
  const lines = [table.fields.map(csvCell).join(",")];
  for (const row of table.rows) lines.push(table.fields.map((field) => csvCell(row[field])).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function printRosterArchive(target: Window, meetingTitle: string, table: ArchiveTable) {
  const doc = target.document;
  doc.documentElement.lang = "zh-CN";
  doc.title = `${meetingTitle} · ${table.label}`;
  const style = doc.createElement("style");
  style.textContent = "@page{size:A4 landscape;margin:12mm}body{font:11px sans-serif}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{border:1px solid #888;padding:3px;vertical-align:top;overflow-wrap:anywhere}td{white-space:pre-wrap}";
  doc.head.append(style);
  const heading = doc.createElement("h1");
  heading.textContent = doc.title;
  const grid = doc.createElement("table");
  const header = grid.createTHead().insertRow();
  for (const field of table.fields) {
    const cell = doc.createElement("th");
    cell.scope = "col";
    cell.textContent = field;
    header.append(cell);
  }
  const body = grid.createTBody();
  for (const row of table.rows) {
    const line = body.insertRow();
    for (const field of table.fields) line.insertCell().textContent = archiveText(row[field]);
  }
  doc.body.replaceChildren(heading, grid);
  target.focus();
  target.print();
}
