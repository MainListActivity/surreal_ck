import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { mapNullToSurrealNone } from "../db/surreal-values";
import { assertCanReadWorkspace, assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import type {
  WorkbookSummaryDTO,
  ListWorkbooksRequest,
  ListWorkbooksResponse,
  CreateBlankWorkbookRequest,
  CreateBlankWorkbookResponse,
  GridColumnDef,
  MoveWorkbookRequest,
  MoveWorkbookResponse,
  RecordIdString,
} from "../../shared/rpc.types";
import {
  gridColumnToStoredDef,
  provisionEntityFields,
  provisionEntityTable,
} from "./data-table-runtime";

// ─── 内部行类型 ───────────────────────────────────────────────────────────────

type WorkbookRow = {
  id: RecordId;
  workspace: RecordId;
  name: string;
  template_key?: string;
  folder?: RecordId;
  updated_at: Date;
};

// ─── 列表 ─────────────────────────────────────────────────────────────────────

export async function listWorkbooks({
  workspaceId,
  folderId,
  search,
}: ListWorkbooksRequest): Promise<ListWorkbooksResponse> {
  await assertCanReadWorkspace(workspaceId);

  const db = getLocalDb();
  const wsId = new StringRecordId(workspaceId);
  const trimmedSearch = search?.trim().toLowerCase() ?? "";
  const params: Record<string, unknown> = { ws: wsId };

  const where: string[] = ["workspace = $ws"];
  if (folderId !== undefined) {
    if (folderId === null) {
      where.push("folder = NONE");
    } else {
      params.folder = new StringRecordId(folderId);
      where.push("folder = $folder");
    }
  }
  if (trimmedSearch) {
    params.search = trimmedSearch;
    where.push("(string::contains(string::lowercase(name), $search) OR string::contains(string::lowercase(template_key ?? ''), $search))");
  }

  const rows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, updated_at
     FROM workbook
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT 200`,
    params
  );

  const workbooks: WorkbookSummaryDTO[] = (rows[0] ?? []).map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace),
    name: row.name,
    templateKey: row.template_key,
    folderId: row.folder ? String(row.folder) : undefined,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));

  return { workbooks };
}

// ─── 创建空白工作簿 ────────────────────────────────────────────────────────────

export async function createBlankWorkbook({
  workspaceId,
  name,
  folderId,
}: CreateBlankWorkbookRequest): Promise<CreateBlankWorkbookResponse> {
  await assertCanWriteWorkspace(workspaceId);

  if (!name || !name.trim()) {
    throw new ServiceError("VALIDATION_ERROR", "工作簿名称不能为空");
  }

  const db = getLocalDb();
  const wsId = new StringRecordId(workspaceId);
  const folderRecordId = folderId ? new StringRecordId(folderId) : null;

  if (folderRecordId) {
    const folderRows = await db.query<[{ id: RecordId }[]]>(
      `SELECT id FROM folder WHERE id = $folderId AND workspace = $ws LIMIT 1`,
      { folderId: folderRecordId, ws: wsId }
    );
    if (!folderRows[0]?.[0]) {
      throw new ServiceError("NOT_FOUND", "文件夹不存在或不属于当前工作区");
    }
  }

  // 生成稳定的 workbook / sheet id
  const wbKey = Bun.hash.wyhash(`${workspaceId}:wb:${Date.now()}`).toString(16).padStart(16, "0");
  const wbId = new RecordId("workbook", wbKey);

  // 动态实体表名：ent_<wbKey>_main（workbook 粒度，非 workspace 粒度的 blank 工作簿）
  const wsKey = workspaceId.replace(/^workspace:/, "").slice(0, 8);
  const entityTableName = `ent_${wsKey}_${wbKey.slice(0, 8)}`;

  const sheetKey = Bun.hash.wyhash(`${wbKey}:sheet:0`).toString(16).padStart(16, "0");
  const sheetId = new RecordId("sheet", sheetKey);

  await ensureWorkbookMetadataSchema();

  // 先创建动态实体表，避免 workbook/sheet 指向不存在的表。
  await provisionEntityTable(entityTableName);
  await provisionEntityFields(entityTableName, [
    { key: "name",  label: "名称",  fieldType: "text", required: true  },
    { key: "value", label: "值",    fieldType: "text", required: false },
    { key: "note",  label: "备注",  fieldType: "text", required: false },
  ]);

  const folderLine = folderRecordId ? "folder: $folder," : "";
  await db.query(
    `UPSERT $wbId CONTENT {
      workspace: $ws,
      name: $name,
      ${folderLine}
      last_opened_sheet: $sheetId
    }`,
    {
      wbId,
      sheetId,
      ws: wsId,
      name: name.trim(),
      folder: folderRecordId,
    }
  );

  await db.query(
    `UPSERT $sheetId CONTENT {
      workbook: $wbId,
      univer_id: rand::ulid(),
      table_name: $tableName,
      label: "Sheet 1",
      position: 0,
      column_defs: [
        { key: "name",  label: "名称",  field_type: "text", required: true  },
        { key: "value", label: "值",    field_type: "text", required: false },
        { key: "note",  label: "备注",  field_type: "text", required: false }
      ]
    }`,
    {
      wbId,
      sheetId,
      tableName: entityTableName,
    }
  );

  // 读取已创建的 workbook
  const wbRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, updated_at FROM workbook WHERE id = $wbId`,
    { wbId }
  );
  const wbRow = wbRows[0]?.[0];
  if (!wbRow) {
    throw new ServiceError("INTERNAL_ERROR", "工作簿创建后读取失败");
  }

  return {
    workbook: {
      id: String(wbRow.id),
      workspaceId: String(wbRow.workspace),
      name: wbRow.name,
      templateKey: wbRow.template_key,
      folderId: wbRow.folder ? String(wbRow.folder) : undefined,
      updatedAt: wbRow.updated_at instanceof Date ? wbRow.updated_at.toISOString() : String(wbRow.updated_at),
    },
  };
}

// ─── 移动 workbook 到目录 ─────────────────────────────────────────────────────

export async function moveWorkbook({
  workbookId,
  folderId,
}: MoveWorkbookRequest): Promise<MoveWorkbookResponse> {
  const db = getLocalDb();
  const wbId = new StringRecordId(workbookId);

  const currentRows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, updated_at FROM workbook WHERE id = $wbId LIMIT 1`,
    { wbId }
  );
  const current = currentRows[0]?.[0];
  if (!current) {
    throw new ServiceError("NOT_FOUND", "工作簿不存在");
  }

  const workspaceId = String(current.workspace);
  await assertCanWriteWorkspace(workspaceId);

  let folderRecordId: StringRecordId | null = null;
  if (folderId) {
    folderRecordId = new StringRecordId(folderId);
    const folderRows = await db.query<[{ id: RecordId; workspace: RecordId }[]]>(
      `SELECT id, workspace FROM folder WHERE id = $folderId LIMIT 1`,
      { folderId: folderRecordId }
    );
    const folder = folderRows[0]?.[0];
    if (!folder) {
      throw new ServiceError("NOT_FOUND", "目标目录不存在");
    }
    if (String(folder.workspace) !== workspaceId) {
      throw new ServiceError("VALIDATION_ERROR", "不能跨工作区移动工作簿");
    }
  }

  const updated = await db.query<[WorkbookRow[]]>(
    `UPDATE $wbId SET folder = $folder`,
    { wbId, folder: mapNullToSurrealNone(folderRecordId) }
  );
  const row = updated[0]?.[0];
  if (!row) throw new ServiceError("INTERNAL_ERROR", "工作簿移动失败");

  return {
    workbook: {
      id: String(row.id),
      workspaceId: String(row.workspace),
      name: row.name,
      templateKey: row.template_key,
      folderId: row.folder ? String(row.folder) : undefined,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    },
  };
}

export async function ensureWorkbookMetadataSchema(): Promise<void> {
  const db = getLocalDb();
  await db.query(
    `REMOVE FIELD IF EXISTS column_defs.* ON TABLE sheet;
     REMOVE FIELD IF EXISTS edge_props.* ON TABLE edge_catalog;
     REMOVE FIELD IF EXISTS fields.* ON TABLE form_definition;
     REMOVE FIELD IF EXISTS field_order.* ON TABLE form_definition;
     REMOVE FIELD IF EXISTS conditional_rules.* ON TABLE form_definition;
     REMOVE FIELD IF EXISTS auto_edges.* ON TABLE form_definition;
     DEFINE FIELD OVERWRITE column_defs ON TABLE sheet TYPE any DEFAULT [];
     DEFINE FIELD OVERWRITE edge_props ON TABLE edge_catalog TYPE any DEFAULT [];
     DEFINE FIELD IF NOT EXISTS cover_url   ON TABLE form_definition TYPE option<string>;
     DEFINE FIELD IF NOT EXISTS description ON TABLE form_definition TYPE option<string>;
     DEFINE FIELD IF NOT EXISTS updated_at  ON TABLE form_definition TYPE datetime VALUE time::now();
     DEFINE FIELD OVERWRITE fields            ON TABLE form_definition TYPE any DEFAULT [];
     DEFINE FIELD OVERWRITE field_order       ON TABLE form_definition TYPE any DEFAULT [];
     DEFINE FIELD OVERWRITE conditional_rules ON TABLE form_definition TYPE any DEFAULT [];
     DEFINE FIELD OVERWRITE auto_edges        ON TABLE form_definition TYPE any DEFAULT [];`
  );
}

// ─── 工具：workbook 所属 workspace 校验 ─────────────────────────────────────

export async function assertWorkbookBelongsToWorkspace(
  workbookId: RecordIdString,
  workspaceId: RecordIdString
): Promise<WorkbookRow> {
  const db = getLocalDb();
  const rows = await db.query<[WorkbookRow[]]>(
    `SELECT id, workspace, name, template_key, folder, updated_at FROM workbook WHERE id = $wbId`,
    { wbId: new StringRecordId(workbookId) }
  );
  const wbRow = rows[0]?.[0];
  if (!wbRow) {
    throw new ServiceError("NOT_FOUND", "工作簿不存在");
  }
  if (String(wbRow.workspace) !== workspaceId) {
    throw new ServiceError("NOT_FOUND", "工作簿不属于当前工作区");
  }
  return wbRow;
}
