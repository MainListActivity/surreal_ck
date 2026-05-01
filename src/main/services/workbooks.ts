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
  GridColumnDef,
  MoveWorkbookRequest,
  MoveWorkbookResponse,
  RecordIdString,
} from "../../shared/rpc.types";
import { normalizeGridFieldConstraints } from "../../shared/field-schema";

// ─── 内部行类型 ───────────────────────────────────────────────────────────────

type WorkbookRow = {
  id: RecordId;
  workspace: RecordId;
  name: string;
  template_key?: string;
  folder?: RecordId;
  updated_at: Date;
};

const ENTITY_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_ENTITY_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

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
    { wbId, folder: folderRecordId }
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

// ─── 内部：DDL provisioning ───────────────────────────────────────────────────

export async function provisionEntityTable(tableName: string): Promise<void> {
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的实体表名: ${tableName}`);
  }
  const db = getLocalDb();
  await db.query(
    `DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_by ON TABLE ${tableName} TYPE option<record<app_user>>;
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

export async function provisionEntityFields(tableName: string, columns: GridColumnDef[]): Promise<void> {
  for (const column of columns) {
    await defineEntityField(tableName, column, "if-not-exists");
  }
}

export async function overwriteEntityField(tableName: string, column: GridColumnDef): Promise<void> {
  await defineEntityField(tableName, column, "overwrite");
}

export async function removeEntityField(tableName: string, key: string): Promise<void> {
  assertEntityTableName(tableName);
  assertEntityFieldName(key);
  const db = getLocalDb();
  await db.query(`REMOVE FIELD IF EXISTS ${key} ON TABLE ${tableName}`);
}

export function normalizeGridColumnDef(column: GridColumnDef): GridColumnDef {
  const key = column.key.trim();
  assertEntityFieldName(key);

  const label = column.label.trim();
  if (!label) {
    throw new ServiceError("VALIDATION_ERROR", "字段名称不能为空");
  }
  if (label.length > 80) {
    throw new ServiceError("VALIDATION_ERROR", "字段名称过长");
  }

  const fieldType = normalizeFieldType(column.fieldType);
  const options = fieldType === "single_select"
    ? [...new Set((column.options ?? []).map((opt) => opt.trim()).filter(Boolean))].slice(0, 80)
    : undefined;
  const constraints = normalizeGridFieldConstraints(fieldType, column.constraints);

  return {
    key,
    label,
    fieldType,
    required: Boolean(column.required),
    options,
    constraints,
  };
}

export function gridColumnToStoredDef(column: GridColumnDef) {
  return {
    key: column.key,
    label: column.label,
    field_type: column.fieldType,
    required: column.required,
    options: column.options,
    constraints: column.constraints,
  };
}

function defineEntityField(tableName: string, column: GridColumnDef, mode: "if-not-exists" | "overwrite"): Promise<void> {
  assertEntityTableName(tableName);
  const normalized = normalizeGridColumnDef(column);
  const clause = mode === "overwrite" ? "OVERWRITE" : "IF NOT EXISTS";
  const surrealType = surrealTypeForField(normalized.fieldType, normalized.required);
  const assertClause = surrealAssertForField(normalized);
  const db = getLocalDb();
  return db.query(
    `DEFINE FIELD ${clause} ${normalized.key} ON TABLE ${tableName} TYPE ${surrealType}${assertClause}`,
  ).then(() => undefined);
}

function surrealTypeForField(fieldType: string, required?: boolean): string {
  const baseType = (() => {
    switch (fieldType) {
      case "text":
      case "single_select":
        return "string";
      case "number":
      case "decimal":
        return "number";
      case "date":
        return "datetime";
      case "checkbox":
        return "bool";
      default:
        throw new ServiceError("VALIDATION_ERROR", `不支持的字段类型: ${fieldType}`);
    }
  })();
  return required ? baseType : `option<${baseType}>`;
}

function normalizeFieldType(fieldType: string): string {
  switch (fieldType) {
    case "text":
    case "single_select":
    case "number":
    case "decimal":
    case "date":
    case "checkbox":
      return fieldType;
    default:
      throw new ServiceError("VALIDATION_ERROR", `不支持的字段类型: ${fieldType}`);
  }
}

function surrealAssertForField(column: GridColumnDef): string {
  const rules: string[] = [];
  const constraints = column.constraints;

  if (column.fieldType === "single_select" && column.options?.length) {
    const options = column.options.map((option) => JSON.stringify(option)).join(", ");
    rules.push(`$value INSIDE [${options}]`);
  }

  if (column.fieldType === "text") {
    if (constraints?.minLength !== undefined) {
      rules.push(`string::len($value) >= ${constraints.minLength}`);
    }
    if (constraints?.maxLength !== undefined) {
      rules.push(`string::len($value) <= ${constraints.maxLength}`);
    }
  }

  if (column.fieldType === "single_select" && constraints?.maxLength !== undefined) {
    rules.push(`string::len($value) <= ${constraints.maxLength}`);
  }

  if (column.fieldType === "number" || column.fieldType === "decimal") {
    if (column.fieldType === "number") {
      rules.push(`math::floor($value) = $value`);
    }
    if (constraints?.min !== undefined) {
      rules.push(`$value >= ${constraints.min}`);
    }
    if (constraints?.max !== undefined) {
      rules.push(`$value <= ${constraints.max}`);
    }
    if (constraints?.step !== undefined) {
      const base = constraints.min ?? 0;
      rules.push(`math::floor((($value - ${base}) / ${constraints.step})) = (($value - ${base}) / ${constraints.step})`);
    }
  }

  if (column.fieldType === "date") {
    if (constraints?.minDate) {
      rules.push(`$value >= d'${constraints.minDate}'`);
    }
    if (constraints?.maxDate) {
      rules.push(`$value <= d'${constraints.maxDate}'`);
    }
  }

  if (!rules.length) return "";
  const body = rules.join(" AND ");
  return column.required ? ` ASSERT ${body}` : ` ASSERT $value = NONE OR (${body})`;
}

function assertEntityTableName(tableName: string): void {
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的实体表名: ${tableName}`);
  }
}

function assertEntityFieldName(key: string): void {
  if (!ENTITY_FIELD_NAME.test(key) || RESERVED_ENTITY_FIELDS.has(key)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的字段标识: ${key}`);
  }
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
