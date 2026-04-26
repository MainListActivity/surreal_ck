import { RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { assertCanReadWorkspace, assertCanWriteWorkspace } from "./context";
import { ServiceError } from "./errors";
import type {
  WorkbookSummaryDTO,
  ListWorkbooksRequest,
  ListWorkbooksResponse,
  CreateBlankWorkbookRequest,
  CreateBlankWorkbookResponse,
  RecordIdString,
} from "../../shared/rpc.types";

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

  // 先创建动态实体表，避免 workbook/sheet 指向不存在的表。
  await provisionEntityTable(entityTableName);

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

// ─── 内部：DDL provisioning ───────────────────────────────────────────────────

export async function provisionEntityTable(tableName: string): Promise<void> {
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的实体表名: ${tableName}`);
  }
  const db = getLocalDb();
  await db.query(
    `DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`
  );
}

export async function provisionRelationTable(tableName: string): Promise<void> {
  if (!/^rel_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的关系表名: ${tableName}`);
  }
  const db = getLocalDb();
  await db.query(
    `DEFINE TABLE IF NOT EXISTS ${tableName} TYPE RELATION SCHEMALESS PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`
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
