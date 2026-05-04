import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanReadWorkspace, assertCanWriteWorkspace, getCurrentUserRecordId, getServiceContext } from "./context";
import { ServiceError } from "./errors";
import {
  createDataTableRuntime,
  gridColumnToStoredDef,
  assertDynamicTableExists,
  normalizeGridColumnDef,
  overwriteEntityField,
  provisionEntityFields,
  provisionEntityTable,
  removeEntityField,
  sheetRowToDTO,
  storedColumnToDTO,
  type DataTableSheetRow,
} from "./data-table-runtime";
import type {
  CreateSheetRequest,
  CreateSheetResponse,
  GetWorkbookDataRequest,
  GetWorkbookDataResponse,
  GridColumnDef,
  RenameSheetRequest,
  RenameSheetResponse,
  RenameWorkbookRequest,
  RenameWorkbookResponse,
  SheetSummaryDTO,
  UpdateSheetFieldsRequest,
  UpdateSheetFieldsResponse,
  UpsertRowsRequest,
  UpsertRowsResponse,
  DeleteRowsRequest,
  DeleteRowsResponse,
  WorkbookSummaryDTO,
} from "../../shared/rpc.types";

export { omitNullishInsertValues } from "./data-table-runtime";

// ─── 内部行类型 ───────────────────────────────────────────────────────────────

type WorkbookRow = {
  id: RecordId;
  workspace: RecordId;
  name: string;
  template_key?: string;
  folder?: RecordId;
  last_opened_sheet?: RecordId;
  updated_at: Date;
};

type SheetRow = DataTableSheetRow;

// ─── getWorkbookData ──────────────────────────────────────────────────────────

export async function getWorkbookData({
  workbookId,
  sheetId,
  viewParams,
}: GetWorkbookDataRequest): Promise<GetWorkbookDataResponse> {
  const db = getLocalDb();

  // 读取 workbook
  const wbRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, last_opened_sheet, updated_at FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(workbookId) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");

  // 授权检查：校验 workspace 访问权限
  await assertCanReadWorkspace(String(wbRow.workspace));

  // 读取所有 sheets
  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT id, workbook, univer_id, table_name, label, position, column_defs FROM sheet WHERE workbook = $wbId ORDER BY position`,
    { wbId: new StringRecordId(workbookId) }
  );
  const sheets: SheetRow[] = sheetRows[0] ?? [];

  if (sheets.length === 0) {
    throw new ServiceError("NOT_FOUND", "工作簿没有 Sheet");
  }

  // 确定活跃 sheet
  let activeSheet: SheetRow;
  if (sheetId) {
    const found = sheets.find((s) => String(s.id) === sheetId);
    if (!found) throw new ServiceError("NOT_FOUND", "Sheet 不存在或不属于该工作簿");
    activeSheet = found;
  } else if (wbRow.last_opened_sheet) {
    activeSheet = sheets.find((s) => String(s.id) === String(wbRow.last_opened_sheet)) ?? sheets[0];
  } else {
    activeSheet = sheets[0];
  }

  if (!getServiceContext().readOnly && String(wbRow.last_opened_sheet) !== String(activeSheet.id)) {
    try {
      await db.query(`UPDATE $wbId SET last_opened_sheet = $sheetId`, {
        wbId: new StringRecordId(workbookId),
        sheetId: activeSheet.id,
      });
    } catch (err) {
      console.warn("[editor] 更新 last_opened_sheet 失败:", err);
    }
  }

  // 读取活跃 sheet 的行数据
  const rows = await createDataTableRuntime(activeSheet).queryRows(viewParams);

  // 映射 column_defs
  const columns: GridColumnDef[] = activeSheet.column_defs.map(storedColumnToDTO);

  const workbook: WorkbookSummaryDTO = {
    id: String(wbRow.id),
    workspaceId: String(wbRow.workspace),
    name: wbRow.name,
    templateKey: wbRow.template_key,
    folderId: wbRow.folder ? String(wbRow.folder) : undefined,
    updatedAt: wbRow.updated_at instanceof Date ? wbRow.updated_at.toISOString() : String(wbRow.updated_at),
  };

  const sheetDTOs: SheetSummaryDTO[] = sheets.map((s) => ({
    id: String(s.id),
    workbookId: String(s.workbook),
    univerId: s.univer_id,
    tableName: s.table_name,
    label: s.label,
    position: s.position,
    columnDefs: s.column_defs.map(storedColumnToDTO),
  }));

  return {
    workbook,
    sheets: sheetDTOs,
    activeSheetId: String(activeSheet.id),
    columns,
    rows,
  };
}

// ─── upsertRows ───────────────────────────────────────────────────────────────

export async function upsertRows({
  sheetId,
  rows,
}: UpsertRowsRequest): Promise<UpsertRowsResponse> {
  const db = getLocalDb();

  // 读取 sheet
  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT id, workbook, table_name, column_defs FROM sheet WHERE id = $sheetId`,
    { sheetId: new StringRecordId(sheetId) }
  );
  const sheet = sheetRows[0]?.[0];
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet 不存在");

  // 取得 workbook workspace 做授权
  const wbRows = await db.query<[{ workspace: RecordId }[]]>(
    `SELECT workspace FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(String(sheet.workbook)) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");
  await assertCanWriteWorkspace(String(wbRow.workspace));

  const currentUserId = await getCurrentUserRecordId();
  const upserted = await createDataTableRuntime(sheet).updateRows(rows, wbRow.workspace, currentUserId);

  return { upserted };
}

// ─── renameWorkbook ──────────────────────────────────────────────────────────

export async function renameWorkbook({
  workbookId,
  name,
}: RenameWorkbookRequest): Promise<RenameWorkbookResponse> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ServiceError("VALIDATION_ERROR", "工作簿名称不能为空");
  }
  if (trimmed.length > 120) {
    throw new ServiceError("VALIDATION_ERROR", "工作簿名称过长");
  }

  const db = getLocalDb();
  const wbRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, last_opened_sheet, updated_at FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(workbookId) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");

  await assertCanWriteWorkspace(String(wbRow.workspace));

  const updated = await db.query<[WorkbookRow[]]>(
    `UPDATE $wbId SET name = $name, updated_at = time::now() RETURN id, workspace, name, template_key, folder, updated_at`,
    { wbId: new StringRecordId(workbookId), name: trimmed }
  );
  const row = updated[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "工作簿名称更新失败");

  return {
    workbook: workbookRowToDTO(row),
  };
}

// ─── updateSheetFields ───────────────────────────────────────────────────────

export async function updateSheetFields({
  sheetId,
  columns,
}: UpdateSheetFieldsRequest): Promise<UpdateSheetFieldsResponse> {
  if (columns.length === 0) {
    throw new ServiceError("VALIDATION_ERROR", "至少保留一个字段");
  }

  const db = getLocalDb();
  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT id, workbook, univer_id, table_name, label, position, column_defs FROM sheet WHERE id = $sheetId`,
    { sheetId: new StringRecordId(sheetId) }
  );
  const sheet = sheetRows[0]?.[0];
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet 不存在");

  const wbRows = await db.query<[{ workspace: RecordId }[]]>(
    `SELECT workspace FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(String(sheet.workbook)) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");
  await assertCanWriteWorkspace(String(wbRow.workspace));

  const tableName = sheet.table_name;
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }
  await assertDynamicTableExists(tableName);

  const normalized = columns.map(normalizeGridColumnDef);
  const seen = new Set<string>();
  for (const column of normalized) {
    if (seen.has(column.key)) {
      throw new ServiceError("VALIDATION_ERROR", `字段标识重复: ${column.key}`);
    }
    seen.add(column.key);
  }

  for (const column of normalized) {
    await overwriteEntityField(tableName, column);
  }

  const nextKeys = new Set(normalized.map((column) => column.key));
  for (const existing of sheet.column_defs) {
    if (!nextKeys.has(existing.key)) {
      await removeEntityField(tableName, existing.key);
    }
  }

  const storedDefs = normalized.map(gridColumnToStoredDef);
  const updated = await db.query<[SheetRow[]]>(
    `UPDATE $sheetId SET column_defs = $columnDefs, updated_at = time::now() RETURN id, workbook, univer_id, table_name, label, position, column_defs`,
    { sheetId: new StringRecordId(sheetId), columnDefs: storedDefs }
  );
  const updatedSheet = updated[0]?.[0];
  if (!updatedSheet) throw new ServiceError("INTERNAL_ERROR", "字段更新失败");

  return {
    sheet: sheetRowToDTO(updatedSheet),
    columns: updatedSheet.column_defs.map(storedColumnToDTO),
  };
}

// ─── createSheet ──────────────────────────────────────────────────────────────

const DEFAULT_NEW_SHEET_COLUMNS: GridColumnDef[] = [
  { key: "name",  label: "名称", fieldType: "text", required: true  },
  { key: "value", label: "值",   fieldType: "text", required: false },
  { key: "note",  label: "备注", fieldType: "text", required: false },
];

export async function createSheet({
  workbookId,
  label,
}: CreateSheetRequest): Promise<CreateSheetResponse> {
  const db = getLocalDb();

  const wbRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, last_opened_sheet, updated_at FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(workbookId) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");

  await assertCanWriteWorkspace(String(wbRow.workspace));

  // 读取已有 sheets 用于推导新 label / position
  const sheetRows = await db.query<[Pick<SheetRow, "id" | "label" | "position">[]]>(
    `SELECT id, label, position FROM sheet WHERE workbook = $wbId ORDER BY position`,
    { wbId: new StringRecordId(workbookId) }
  );
  const sheets = sheetRows[0] ?? [];

  const trimmedLabel = label?.trim();
  let finalLabel: string;
  if (trimmedLabel) {
    if (trimmedLabel.length > 80) {
      throw new ServiceError("VALIDATION_ERROR", "Sheet 名称过长");
    }
    if (sheets.some((s) => s.label === trimmedLabel)) {
      throw new ServiceError("VALIDATION_ERROR", "Sheet 名称已存在");
    }
    finalLabel = trimmedLabel;
  } else {
    const existingLabels = new Set(sheets.map((s) => s.label));
    let i = sheets.length + 1;
    let candidate = `Sheet ${i}`;
    while (existingLabels.has(candidate)) {
      i += 1;
      candidate = `Sheet ${i}`;
    }
    finalLabel = candidate;
  }

  const nextPosition = sheets.reduce((max, s) => Math.max(max, s.position ?? 0), -1) + 1;

  const wbKey = String(wbRow.id).replace(/^workbook:/, "");
  const wsKey = String(wbRow.workspace).replace(/^workspace:/, "").slice(0, 8);
  const sheetKey = Bun.hash.wyhash(`${wbKey}:sheet:${nextPosition}:${Date.now()}`)
    .toString(16)
    .padStart(16, "0");
  const tableName = `ent_${wsKey}_${wbKey.slice(0, 8)}_${sheetKey.slice(0, 8)}`;
  const sheetId = new RecordId("sheet", sheetKey);

  await provisionEntityTable(tableName);
  await provisionEntityFields(tableName, DEFAULT_NEW_SHEET_COLUMNS);

  const storedDefs = DEFAULT_NEW_SHEET_COLUMNS.map(gridColumnToStoredDef);
  const created = await db.query<[SheetRow[]]>(
    `UPSERT $sheetId CONTENT {
      workbook: $wbId,
      univer_id: rand::ulid(),
      table_name: $tableName,
      label: $label,
      position: $position,
      column_defs: $columnDefs
    } RETURN id, workbook, univer_id, table_name, label, position, column_defs`,
    {
      sheetId,
      wbId: new StringRecordId(workbookId),
      tableName,
      label: finalLabel,
      position: nextPosition,
      columnDefs: storedDefs,
    }
  );
  const createdSheet = created[0]?.[0];
  if (!createdSheet) throw new ServiceError("INTERNAL_ERROR", "Sheet 创建失败");

  return { sheet: sheetRowToDTO(createdSheet) };
}

// ─── renameSheet ──────────────────────────────────────────────────────────────

export async function renameSheet({
  sheetId,
  label,
}: RenameSheetRequest): Promise<RenameSheetResponse> {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new ServiceError("VALIDATION_ERROR", "Sheet 名称不能为空");
  }
  if (trimmed.length > 80) {
    throw new ServiceError("VALIDATION_ERROR", "Sheet 名称过长");
  }

  const db = getLocalDb();
  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT id, workbook, univer_id, table_name, label, position, column_defs FROM sheet WHERE id = $sheetId`,
    { sheetId: new StringRecordId(sheetId) }
  );
  const sheet = sheetRows[0]?.[0];
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet 不存在");

  const wbRows = await db.query<[{ workspace: RecordId }[]]>(
    `SELECT workspace FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(String(sheet.workbook)) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");
  await assertCanWriteWorkspace(String(wbRow.workspace));

  if (trimmed === sheet.label) {
    return { sheet: sheetRowToDTO(sheet) };
  }

  const dupRows = await db.query<[{ id: RecordId }[]]>(
    `SELECT id FROM sheet WHERE workbook = $wbId AND label = $label AND id != $sheetId LIMIT 1`,
    {
      wbId: sheet.workbook,
      label: trimmed,
      sheetId: new StringRecordId(sheetId),
    }
  );
  if (dupRows[0]?.[0]) {
    throw new ServiceError("VALIDATION_ERROR", "Sheet 名称已存在");
  }

  const updated = await db.query<[SheetRow[]]>(
    `UPDATE $sheetId SET label = $label, updated_at = time::now() RETURN id, workbook, univer_id, table_name, label, position, column_defs`,
    { sheetId: new StringRecordId(sheetId), label: trimmed }
  );
  const updatedSheet = updated[0]?.[0];
  if (!updatedSheet) throw new ServiceError("INTERNAL_ERROR", "Sheet 重命名失败");

  return { sheet: sheetRowToDTO(updatedSheet) };
}

// ─── deleteRows ───────────────────────────────────────────────────────────────

export async function deleteRows({
  sheetId,
  ids,
}: DeleteRowsRequest): Promise<DeleteRowsResponse> {
  const db = getLocalDb();

  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT workbook, table_name FROM sheet WHERE id = $sheetId`,
    { sheetId: new StringRecordId(sheetId) }
  );
  const sheet = sheetRows[0]?.[0];
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet 不存在");

  const wbRows = await db.query<[{ workspace: RecordId }[]]>(
    `SELECT workspace FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(String(sheet.workbook)) }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) throw new ServiceError("NOT_FOUND", "工作簿不存在");
  await assertCanWriteWorkspace(String(wbRow.workspace));

  const deleted = await createDataTableRuntime(sheet).deleteRows(ids);

  return { deleted };
}

function workbookRowToDTO(row: WorkbookRow): WorkbookSummaryDTO {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace),
    name: row.name,
    templateKey: row.template_key,
    folderId: row.folder ? String(row.folder) : undefined,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
