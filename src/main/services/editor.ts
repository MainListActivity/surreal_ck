import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { mapNullsToSurrealNone, omitNullishSurrealFields } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanWriteWorkspace, getCurrentUserRecordId, getServiceContext } from "./context";
import { ServiceError } from "./errors";
import {
  gridColumnToStoredDef,
  normalizeGridColumnDef,
  overwriteEntityField,
  provisionEntityFields,
  provisionEntityTable,
  removeEntityField,
} from "./workbooks";
import { coerceGridFieldValue, validateGridFieldValue } from "../../shared/field-schema";
import type {
  CreateSheetRequest,
  CreateSheetResponse,
  FilterClause,
  GetWorkbookDataRequest,
  GetWorkbookDataResponse,
  GridColumnDef,
  GridRow,
  RenameSheetRequest,
  RenameSheetResponse,
  RenameWorkbookRequest,
  RenameWorkbookResponse,
  SheetSummaryDTO,
  SortClause,
  UpdateSheetFieldsRequest,
  UpdateSheetFieldsResponse,
  UpsertRowsRequest,
  UpsertRowsResponse,
  DeleteRowsRequest,
  DeleteRowsResponse,
  ViewParams,
  WorkbookSummaryDTO,
} from "../../shared/rpc.types";

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

type SheetRow = {
  id: RecordId;
  workbook: RecordId;
  univer_id: string;
  table_name: string;
  label: string;
  position: number;
  column_defs: Array<{
    key: string;
    label: string;
    field_type: string;
    required?: boolean;
    options?: string[];
    constraints?: GridColumnDef["constraints"];
    date_format?: string;
  }>;
};

type EntityRow = Record<string, unknown> & { id: RecordId; workspace?: RecordId };

type StoredColumnDef = SheetRow["column_defs"][number];

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
  const rows = await loadEntityRows(activeSheet, viewParams);

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

  // 校验 column keys（未定义字段忽略）
  const validKeys = new Set(sheet.column_defs.map((c) => c.key));
  const columnsByKey = new Map(sheet.column_defs.map((c) => [c.key, storedColumnToDTO(c)]));
  const tableName = sheet.table_name;

  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }
  await assertDynamicTableExists(tableName);
  await ensureEntityAuditFields(tableName);
  const currentUserId = await getCurrentUserRecordId();

  const upserted: GridRow[] = [];

  for (const rowPatch of rows) {
    // 过滤掉 schema 未定义的字段
    const cleanValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rowPatch.values)) {
      if (!validKeys.has(k)) continue;
      const column = columnsByKey.get(k);
      const coerced = coerceCellValue(v, column);
      cleanValues[k] = coerced;
    }
    for (const column of columnsByKey.values()) {
      const fieldErrors = validateGridFieldValue(cleanValues[column.key], column);
      if (fieldErrors.length) {
        throw new ServiceError("VALIDATION_ERROR", `${column.label}: ${fieldErrors[0]}`);
      }
    }
    // 校验通过后把 date 字段包装成 SurrealDB DateTime（ns 精度），写库后再用
    for (const column of columnsByKey.values()) {
      if (column.fieldType !== "date") continue;
      const v = cleanValues[column.key];
      if (v instanceof Date) cleanValues[column.key] = new DateTime(v);
    }

    if (rowPatch.id) {
      assertRowIdBelongsToTable(rowPatch.id, tableName);
      // 更新已有行
      const updateValues = mapNullsToSurrealNone({ ...cleanValues, updated_at: new DateTime() });
      const updated = await db.query<[EntityRow[]]>(
        `UPDATE $rowId MERGE $vals`,
        { rowId: new StringRecordId(rowPatch.id), vals: updateValues }
      );
      const r = updated[0]?.[0];
      if (r) {
        upserted.push(entityRowToDTO(r, validKeys));
      }
    } else {
      // 新增行
      const createValues = omitNullishInsertValues(cleanValues);
      createValues.workspace = wbRow.workspace;
      createValues.created_by = currentUserId;
      const created = await db.query<[EntityRow[]]>(
        `CREATE type::table($t) CONTENT $vals`,
        { t: tableName, vals: createValues }
      );
      const r = created[0]?.[0];
      if (r) {
        upserted.push(entityRowToDTO(r, validKeys));
      }
    }
  }

  return { upserted };
}

export function omitNullishInsertValues(values: Record<string, unknown>): Record<string, unknown> {
  return omitNullishSurrealFields(values);
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

  const tableName = sheet.table_name;
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }

  let deleted = 0;
  for (const id of ids) {
    assertRowIdBelongsToTable(id, tableName);
    await db.query(`DELETE $rowId`, { rowId: new StringRecordId(id) });
    deleted++;
  }

  return { deleted };
}

// ─── 内部：从实体表加载行 ─────────────────────────────────────────────────────

async function loadEntityRows(sheet: SheetRow, viewParams?: ViewParams): Promise<GridRow[]> {
  const tableName = sheet.table_name;
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }

  const db = getLocalDb();
  const columnsByKey = new Map(sheet.column_defs.map((c) => [c.key, c]));
  const validKeys = new Set(columnsByKey.keys());

  await assertDynamicTableExists(tableName);

  const compiled = compileViewQuery(viewParams, columnsByKey);
  const sql =
    `SELECT * FROM type::table($t)` +
    (compiled.where ? ` WHERE ${compiled.where}` : "") +
    (compiled.orderBy ? ` ORDER BY ${compiled.orderBy}` : "") +
    ` LIMIT 5000`;

  const result = await db.query<[EntityRow[]]>(sql, {
    t: tableName,
    ...compiled.bindings,
  });
  return (result[0] ?? []).map((row) => entityRowToDTO(row, validKeys));
}

// ─── ViewParams → SurrealQL 拼装 ─────────────────────────────────────────────

const FILTER_OP_TO_SQL: Record<FilterClause["op"], { sql: string; needValue: "scalar" | "array" | "none" }> = {
  eq:           { sql: "=",         needValue: "scalar" },
  neq:          { sql: "!=",        needValue: "scalar" },
  gt:           { sql: ">",         needValue: "scalar" },
  gte:          { sql: ">=",        needValue: "scalar" },
  lt:           { sql: "<",         needValue: "scalar" },
  lte:          { sql: "<=",        needValue: "scalar" },
  contains:     { sql: "CONTAINS",  needValue: "scalar" },
  not_contains: { sql: "CONTAINSNOT", needValue: "scalar" },
  in:           { sql: "INSIDE",    needValue: "array"  },
  is_null:      { sql: "IS NULL",   needValue: "none"   },
  is_not_null:  { sql: "IS NOT NULL", needValue: "none" },
};

/**
 * 将 ViewParams 编译为 WHERE / ORDER BY 片段。
 *
 * 字段名走白名单（必须存在于 sheet.column_defs.key），通过校验后直接拼到 SQL 标识符位置；
 * 用户输入的字面值一律通过 $p0/$p1/... 参数绑定，避免任何注入。
 */
function compileViewQuery(
  viewParams: ViewParams | undefined,
  columnsByKey: Map<string, StoredColumnDef>,
): { where: string; orderBy: string; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  let bindIndex = 0;
  const bind = (value: unknown) => {
    const name = `p${bindIndex++}`;
    bindings[name] = value;
    return `$${name}`;
  };

  const wherePieces: string[] = [];
  for (const clause of viewParams?.filters ?? []) {
    const column = columnsByKey.get(clause.key);
    if (!column) continue; // 字段已被删除，跳过该条件
    if (!isSafeIdentifier(clause.key)) continue;

    const opDef = FILTER_OP_TO_SQL[clause.op];
    if (!opDef) continue;

    if (opDef.needValue === "none") {
      wherePieces.push(`${clause.key} ${opDef.sql}`);
      continue;
    }
    if (opDef.needValue === "array") {
      const arr = Array.isArray(clause.value) ? clause.value : [];
      if (arr.length === 0) continue;
      wherePieces.push(`${clause.key} ${opDef.sql} ${bind(arr.map((v) => coerceFilterValue(v, column)))}`);
      continue;
    }
    if (clause.value === undefined || clause.value === null || clause.value === "") continue;
    wherePieces.push(`${clause.key} ${opDef.sql} ${bind(coerceFilterValue(clause.value, column))}`);
  }

  const filterMode = viewParams?.filterMode === "or" ? " OR " : " AND ";
  const where = wherePieces.length ? wherePieces.join(filterMode) : "";

  const orderPieces: string[] = [];
  for (const sort of viewParams?.sorts ?? []) {
    if (!columnsByKey.has(sort.key)) continue;
    if (!isSafeIdentifier(sort.key)) continue;
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderPieces.push(`${sort.key} ${dir}`);
  }
  const orderBy = orderPieces.join(", ");

  return { where, orderBy, bindings };
}

/** 字段 key 在 schema 中已经被规范化（snake_case），这里二次校验防御。 */
function isSafeIdentifier(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/** 把字面值按列类型做最小转换，复用 cell 的 coerce 规则；date 字段额外包装为 DateTime 以匹配 SurrealQL datetime。 */
function coerceFilterValue(value: unknown, column: StoredColumnDef): unknown {
  const coerced = coerceCellValue(value, storedColumnToDTO(column));
  if (column.field_type === "date" && coerced instanceof Date) {
    return new DateTime(coerced);
  }
  return coerced;
}

function entityRowToDTO(row: EntityRow, validKeys: Set<string>): GridRow {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "workspace" || k === "created_by" || k === "created_at" || k === "updated_at") continue;
    if (validKeys.has(k)) values[k] = jsonifyDbValue(v);
  }
  return { id: String(row.id), values };
}

/** 把 SurrealDB sdk 反序列化出来的 DateTime / Date / RecordId 转成 RPC 安全的标量，避免 JSON.stringify 丢精度。 */
function jsonifyDbValue(value: unknown): unknown {
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return String(value);
  return value;
}

function storedColumnToDTO(c: StoredColumnDef): GridColumnDef {
  return {
    key: c.key,
    label: c.label,
    fieldType: c.field_type,
    required: c.required,
    options: c.options,
    constraints: c.constraints,
    dateFormat: c.date_format,
  };
}

function sheetRowToDTO(s: SheetRow): SheetSummaryDTO {
  return {
    id: String(s.id),
    workbookId: String(s.workbook),
    univerId: s.univer_id,
    label: s.label,
    position: s.position,
    columnDefs: s.column_defs.map(storedColumnToDTO),
  };
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

function coerceCellValue(value: unknown, column?: GridColumnDef): unknown {
  return coerceGridFieldValue(value, column);
}

async function assertDynamicTableExists(tableName: string): Promise<void> {
  const db = getLocalDb();
  const info = await db.query<[{ tables?: Record<string, unknown> }]>(`INFO FOR DB`);
  const tables = info[0]?.tables ?? {};
  if (!Object.prototype.hasOwnProperty.call(tables, tableName)) {
    throw new ServiceError("NOT_FOUND", `动态实体表不存在: ${tableName}`);
  }
}

async function ensureEntityAuditFields(tableName: string): Promise<void> {
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }
  const db = getLocalDb();
  await db.query(
    `DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_by ON TABLE ${tableName} TYPE option<record<app_user>>;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`
  );
}

function assertRowIdBelongsToTable(rowId: string, tableName: string): void {
  if (!rowId.startsWith(`${tableName}:`)) {
    throw new ServiceError("NOT_FOUND", "记录不属于当前 Sheet");
  }
}
