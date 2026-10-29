import { formatDateValue } from "@surreal-ck/shared/date-format";
import type { GridColumnDef, GridRow, ViewParams } from "@surreal-ck/shared/dto";
import { openDataTableRuntime, type DataTableRuntime } from "./data-table-runtime";
import type { SheetMeta } from "./editor-store";
import type { SurrealConn } from "./surreal";

/**
 * 工作簿 CSV 导出：每张当前成员可读的数据表导出一个文件。
 *
 * 读取走与表格页相同的 runtime（成员会话 + 全量分页扫描），不增加后端代理。
 * 任一表读取失败则整体不下载，避免给出缺表的部分导出。
 */

export type WorkbookCsvFile = { fileName: string; content: string };

export type WorkbookCsvInput = {
  workbookName: string;
  sheets: SheetMeta[];
  openRuntime: (sheet: SheetMeta) => Promise<DataTableRuntime>;
  today: string;
};

const CSV_BOM = "﻿";
const FULL_TABLE_VIEW: ViewParams = {
  filters: [],
  filterMode: "and",
  sorts: [],
  hiddenFields: [],
  groupBy: null,
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const text = Array.isArray(value) ? value.map(String).join("；") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 与表格页相同的展示口径：日期按字段 dateFormat 格式化，其余值原样写出。 */
function cellText(column: GridColumnDef, value: unknown): unknown {
  if (column.fieldType === "date") return formatDateValue(value, column.dateFormat);
  return value;
}

/** 生成单表 CSV（UTF-8 BOM，CRLF）。列头用字段标签，行数等于读到的记录数。 */
export function buildSheetCsv(columns: GridColumnDef[], rows: GridRow[]): string {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(cellText(column, row.values[column.key]))).join(","));
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

function safeFileNamePart(value: string, fallback: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
  return cleaned || fallback;
}

/** 逐表读取并生成文件。全部成功才返回；任一表失败则抛错，不返回部分结果。 */
export async function buildWorkbookCsvFiles(input: WorkbookCsvInput): Promise<WorkbookCsvFile[]> {
  const files: WorkbookCsvFile[] = [];
  for (const sheet of input.sheets) {
    const runtime = await input.openRuntime(sheet);
    try {
      const scanned = await runtime.scanAllRecords();
      const fileName = [
        safeFileNamePart(input.workbookName, "工作簿"),
        safeFileNamePart(sheet.label, "工作表"),
        input.today,
      ].join("-") + ".csv";
      files.push({ fileName, content: buildSheetCsv(runtime.snapshot.columns, scanned.records) });
    } finally {
      await runtime.close();
    }
  }
  return files;
}

export function downloadCsvFile(file: WorkbookCsvFile): void {
  const blob = new Blob([file.content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 顶栏入口：读取当前工作簿全部数据表并逐个下载。 */
export async function exportWorkbookCsv(input: {
  conn: SurrealConn;
  workbookId: string;
  workbookName: string;
  sheets: SheetMeta[];
}): Promise<WorkbookCsvFile[]> {
  const files = await buildWorkbookCsvFiles({
    workbookName: input.workbookName,
    sheets: input.sheets,
    today: new Date().toISOString().slice(0, 10),
    openRuntime: (sheet) => openDataTableRuntime({
      conn: input.conn,
      workbookId: input.workbookId,
      dataTableId: sheet.id,
      query: FULL_TABLE_VIEW,
    }),
  });
  for (const file of files) downloadCsvFile(file);
  return files;
}
