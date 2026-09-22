import { DateTime } from "surrealdb";
import { mapNullsToSurrealNone } from "@surreal-ck/shared/surreal-values";
import type { TemplateImportMapping, TemplateImportRejectedRow } from "./template-sheet-import";
import { recordValueToString, toRecordId } from "./record-id";
import type { SurrealConn } from "./surreal";

export type ImportBatchStatus =
  | "processing"
  | "completed"
  | "partial_failure"
  | "failed"
  | "outcome_unknown"
  | "undone";

export type ImportBatchSheetStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "ignored"
  | "outcome_unknown";

export type ImportBatchSnapshot = {
  id: string;
  workbookId: string | null;
  fileName: string;
  fileDigest: string;
  mappingVersion: string;
  mode: "new_workbook" | "existing_tables" | "mixed";
  status: ImportBatchStatus;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  sheets: Array<{
    sheetName: string;
    targetSheetId: string | null;
    mappingVersion: string;
    status: ImportBatchSheetStatus;
    importedCount: number;
    rejectedCount: number;
    error: string | null;
  }>;
  rows: Array<{
    sheetName: string;
    rowNumber: number;
    status: "success" | "rejected" | "outcome_unknown";
    targetRecordId: string | null;
    targetUpdatedAt: string | null;
    field: string | null;
    reason: string | null;
    sourceCells: string[];
  }>;
};

export type ImportBatchService = ReturnType<typeof createImportBatchService>;

type StoredBatch = {
  id: unknown;
  workbook?: unknown;
  file_name?: unknown;
  file_digest?: unknown;
  mapping_version?: unknown;
  mode?: unknown;
  status?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  updated_at?: unknown;
};

type StoredBatchSheet = {
  sheet_name?: unknown;
  target_sheet?: unknown;
  mapping_version?: unknown;
  status?: unknown;
  imported_count?: unknown;
  rejected_count?: unknown;
  error?: unknown;
};

type StoredBatchRow = {
  sheet_name?: unknown;
  source_row_number?: unknown;
  status?: unknown;
  target_record?: unknown;
  target_updated_at?: unknown;
  field?: unknown;
  reason?: unknown;
  source_cells?: unknown;
};

export function createImportBatchService(conn: SurrealConn) {
  async function start(input: {
    fileName: string;
    fileDigest: string;
    mappingVersion: string;
    mode: ImportBatchSnapshot["mode"];
    workbookId?: string;
    sheets: Array<{
      sheetName: string;
      targetSheetId?: string;
      mappings: TemplateImportMapping[];
      ignored?: boolean;
    }>;
  }): Promise<{ id: string }> {
    const createdValue = await conn.createRecord<StoredBatch | StoredBatch[]>("import_batch", {
      ...(input.workbookId ? { workbook: toRecordId(input.workbookId) } : {}),
      file_name: input.fileName,
      file_digest: input.fileDigest,
      mapping_version: input.mappingVersion,
      mode: input.mode,
      status: "processing",
    });
    const created = Array.isArray(createdValue) ? createdValue[0] : createdValue;
    const id = recordValueToString(created?.id);
    if (typeof id !== "string" || !id.startsWith("import_batch:")) {
      throw new Error("导入批次创建后未返回有效标识");
    }
    for (const sheet of input.sheets) {
      await conn.query(
        `INSERT INTO import_batch_sheet {
          batch: $batch,
          sheet_name: $sheetName,
          target_sheet: $targetSheet,
          mapping_version: $mappingVersion,
          mappings: $mappings,
          status: $status
        } ON DUPLICATE KEY UPDATE
          target_sheet = $targetSheet,
          mapping_version = $mappingVersion,
          mappings = $mappings,
          status = $status,
          updated_at = time::now()
        RETURN AFTER`,
        mapNullsToSurrealNone({
          batch: toRecordId(id),
          sheetName: sheet.sheetName,
          targetSheet: sheet.targetSheetId ? toRecordId(sheet.targetSheetId) : null,
          mappingVersion: input.mappingVersion,
          mappings: sheet.mappings,
          status: sheet.ignored ? "ignored" : "pending",
        }),
      );
    }
    return { id };
  }

  async function finishSheet(
    batchId: string,
    sheetName: string,
    result: {
      status: Exclude<ImportBatchSheetStatus, "pending" | "processing">;
      importedCount: number;
      rejectedCount: number;
      error?: string | null;
      targetSheetId?: string;
    },
  ): Promise<void> {
    await conn.query(
      `UPDATE import_batch_sheet SET
        status = $status,
        imported_count = $importedCount,
        rejected_count = $rejectedCount,
        error = $error,
        target_sheet = IF $targetSheet = NONE THEN target_sheet ELSE $targetSheet END,
        updated_at = time::now()
      WHERE batch = $batch AND sheet_name = $sheetName`,
      mapNullsToSurrealNone({
        batch: toRecordId(batchId),
        sheetName,
        status: result.status,
        importedCount: result.importedCount,
        rejectedCount: result.rejectedCount,
        error: result.error ?? null,
        targetSheet: result.targetSheetId ? toRecordId(result.targetSheetId) : null,
      }),
    );
  }

  async function finish(batchId: string, status: Exclude<ImportBatchStatus, "processing">): Promise<void> {
    await conn.updateRecord(batchId, {
      status,
      completed_at: new DateTime(new Date().toISOString()),
    });
  }

  async function load(batchId: string): Promise<ImportBatchSnapshot | null> {
    const [batches, sheets, rows] = await Promise.all([
      conn.query<StoredBatch>("SELECT * FROM import_batch WHERE id = $batch LIMIT 1", {
        batch: toRecordId(batchId),
      }),
      conn.query<StoredBatchSheet>(
        "SELECT * FROM import_batch_sheet WHERE batch = $batch ORDER BY created_at ASC",
        { batch: toRecordId(batchId) },
      ),
      conn.query<StoredBatchRow>(
        "SELECT * FROM import_batch_row WHERE batch = $batch ORDER BY sheet_name ASC, source_row_number ASC",
        { batch: toRecordId(batchId) },
      ),
    ]);
    const batch = batches[0];
    if (!batch) return null;
    return {
      id: String(batch.id),
      workbookId: optionalString(batch.workbook),
      fileName: stringValue(batch.file_name),
      fileDigest: stringValue(batch.file_digest),
      mappingVersion: stringValue(batch.mapping_version),
      mode: batch.mode as ImportBatchSnapshot["mode"],
      status: batch.status as ImportBatchStatus,
      startedAt: stringValue(batch.started_at),
      completedAt: optionalString(batch.completed_at),
      updatedAt: stringValue(batch.updated_at),
      sheets: sheets.map((sheet) => ({
        sheetName: stringValue(sheet.sheet_name),
        targetSheetId: optionalString(sheet.target_sheet),
        mappingVersion: stringValue(sheet.mapping_version),
        status: sheet.status as ImportBatchSheetStatus,
        importedCount: numberValue(sheet.imported_count),
        rejectedCount: numberValue(sheet.rejected_count),
        error: optionalString(sheet.error),
      })),
      rows: rows.map((row) => ({
        sheetName: stringValue(row.sheet_name),
        rowNumber: numberValue(row.source_row_number),
        status: row.status as ImportBatchSnapshot["rows"][number]["status"],
        targetRecordId: optionalString(row.target_record),
        targetUpdatedAt: optionalString(row.target_updated_at),
        field: optionalString(row.field),
        reason: optionalString(row.reason),
        sourceCells: Array.isArray(row.source_cells) ? row.source_cells.map(String) : [],
      })),
    };
  }

  async function listRecent(limit = 10): Promise<ImportBatchSnapshot[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const batches = await conn.query<Pick<StoredBatch, "id">>(
      "SELECT id FROM import_batch ORDER BY updated_at DESC LIMIT $limit",
      { limit: safeLimit },
    );
    const loaded = await Promise.all(batches.map((batch) => load(String(batch.id))));
    return loaded.filter((batch): batch is ImportBatchSnapshot => batch !== null);
  }

  return { start, finishSheet, finish, load, listRecent };
}

export function rejectedRowsToCsv(headers: string[], rows: TemplateImportRejectedRow[]): string {
  const matrix = [
    ["原始行号", "失败字段", "失败原因", ...headers],
    ...rows.map((row) => [String(row.rowNumber), row.field, row.reason, ...row.sourceCells]),
  ];
  return matrix.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function importFingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `v1-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function optionalString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
