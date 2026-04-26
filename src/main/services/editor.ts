import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanReadWorkspace, assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import type {
  GetWorkbookDataRequest,
  GetWorkbookDataResponse,
  UpsertRowsRequest,
  UpsertRowsResponse,
  DeleteRowsRequest,
  DeleteRowsResponse,
  GridColumnDef,
  GridRow,
  SheetSummaryDTO,
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
  }>;
};

type EntityRow = Record<string, unknown> & { id: RecordId; workspace?: RecordId };

// ─── getWorkbookData ──────────────────────────────────────────────────────────

export async function getWorkbookData({
  workbookId,
  sheetId,
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
  assertCanReadWorkspace(String(wbRow.workspace));

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

  // 读取活跃 sheet 的行数据
  const rows = await loadEntityRows(activeSheet);

  // 映射 column_defs
  const columns: GridColumnDef[] = activeSheet.column_defs.map((c) => ({
    key: c.key,
    label: c.label,
    fieldType: c.field_type,
    required: c.required,
    options: c.options,
  }));

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
    columnDefs: s.column_defs.map((c) => ({
      key: c.key,
      label: c.label,
      fieldType: c.field_type,
      required: c.required,
      options: c.options,
    })),
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
  assertCanWriteWorkspace(String(wbRow.workspace));

  // 校验 column keys（未定义字段忽略）
  const validKeys = new Set(sheet.column_defs.map((c) => c.key));
  const tableName = sheet.table_name;

  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("INTERNAL_ERROR", "无效的实体表名");
  }

  const upserted: GridRow[] = [];

  for (const rowPatch of rows) {
    // 过滤掉 schema 未定义的字段
    const cleanValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rowPatch.values)) {
      if (validKeys.has(k)) cleanValues[k] = v;
    }

    if (rowPatch.id) {
      // 更新已有行
      const updated = await db.query<[EntityRow[]]>(
        `UPDATE $rowId MERGE $vals`,
        { rowId: new StringRecordId(rowPatch.id), vals: cleanValues }
      );
      const r = updated[0]?.[0];
      if (r) {
        upserted.push(entityRowToDTO(r, validKeys));
      }
    } else {
      // 新增行
      const created = await db.query<[EntityRow[]]>(
        `CREATE type::table($t) CONTENT $vals`,
        { t: tableName, vals: cleanValues }
      );
      const r = created[0]?.[0];
      if (r) {
        upserted.push(entityRowToDTO(r, validKeys));
      }
    }
  }

  return { upserted };
}

// ─── deleteRows ───────────────────────────────────────────────────────────────

export async function deleteRows({
  sheetId,
  ids,
}: DeleteRowsRequest): Promise<DeleteRowsResponse> {
  const db = getLocalDb();

  const sheetRows = await db.query<[SheetRow[]]>(
    `SELECT workbook FROM sheet WHERE id = $sheetId`,
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
  assertCanWriteWorkspace(String(wbRow.workspace));

  let deleted = 0;
  for (const id of ids) {
    await db.query(`DELETE $rowId`, { rowId: new StringRecordId(id) });
    deleted++;
  }

  return { deleted };
}

// ─── 内部：从实体表加载行 ─────────────────────────────────────────────────────

async function loadEntityRows(sheet: SheetRow): Promise<GridRow[]> {
  const tableName = sheet.table_name;
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) return [];

  const db = getLocalDb();
  const validKeys = new Set(sheet.column_defs.map((c) => c.key));

  try {
    const result = await db.query<[EntityRow[]]>(
      `SELECT * FROM type::table($t) LIMIT 5000`,
      { t: tableName }
    );
    return (result[0] ?? []).map((row) => entityRowToDTO(row, validKeys));
  } catch {
    return [];
  }
}

function entityRowToDTO(row: EntityRow, validKeys: Set<string>): GridRow {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "workspace" || k === "created_at" || k === "updated_at") continue;
    if (validKeys.has(k)) values[k] = v;
  }
  return { id: String(row.id), values };
}
