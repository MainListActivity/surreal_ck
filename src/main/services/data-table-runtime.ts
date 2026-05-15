import {
  and,
  BoundQuery,
  contains,
  DateTime,
  eq,
  expr,
  gt,
  gte,
  inside,
  lt,
  lte,
  ne,
  not,
  or,
  raw,
  RecordId,
  StringRecordId,
  Table,
  type Expr,
  type ExprLike,
} from "surrealdb";
import { getLocalDb } from "../db/index";
import { mapNullsToSurrealNone, omitNullishSurrealFields } from "../db/surreal-values";
import { execTemplate } from "../sync/exec-template";
import { ServiceError } from "./errors";
import { getServiceContext } from "./context";
import { assertCapabilityAllowed } from "./capabilities";
import {
  buildSurrealFieldSchema,
  coerceGridFieldValue,
  gridColumnToStoredDef,
  normalizeGridColumnDef as normalizeSharedGridColumnDef,
  storedColumnToDTO,
  validateGridFieldValue,
} from "../../shared/field-schema";
import type { StoredGridFieldDef } from "../../shared/field-schema";
import type {
  FilterClause,
  GridColumnDef,
  GridRow,
  RecordIdString,
  ReferenceTargetPreview,
  SheetSummaryDTO,
  SortClause,
  TableSchemaField,
  ViewParams,
} from "../../shared/rpc.types";

export {
  gridColumnToStoredDef,
  storedColumnToDTO,
};

export type StoredColumnDef = StoredGridFieldDef;

export type DataTableSheetRow = {
  id: RecordId;
  workbook: RecordId;
  univer_id: string;
  table_name: string;
  label: string;
  position: number;
  column_defs: StoredColumnDef[];
};

export type DataTableContext = {
  workspaceId?: string;
  workspaceName?: string;
  workbookId?: string;
  workbookName?: string;
};

type EntityRow = Record<string, unknown> & { id: RecordId; workspace?: RecordId };
const ENTITY_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_ENTITY_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

export class DataTableRuntime {
  readonly sheet: DataTableSheetRow;
  readonly context: DataTableContext;

  constructor(sheet: DataTableSheetRow, context: DataTableContext = {}) {
    assertEntityTableName(sheet.table_name);
    this.sheet = sheet;
    this.context = context;
  }

  get tableName(): string {
    return this.sheet.table_name;
  }

  get columns(): GridColumnDef[] {
    return this.sheet.column_defs.map(storedColumnToDTO);
  }

  buildEntityPreview(
    rowId: RecordIdString,
    row: Record<string, unknown>,
    opts?: { forceDisplayKey?: string },
  ): ReferenceTargetPreview {
    const displayKey = opts?.forceDisplayKey ?? this.defaultDisplayKey();
    const primaryLabel = this.formatPrimaryLabel(row, displayKey, rowId);
    const preview: ReferenceTargetPreview["preview"] = [];
    for (const col of this.sheet.column_defs) {
      if (preview.length >= 5) break;
      const v = row[col.key];
      if (v === undefined || v === null || v === "") continue;
      preview.push({ key: col.key, label: col.label, value: jsonifyValue(v) });
    }
    return {
      id: rowId,
      table: this.tableName,
      workspaceId: this.context.workspaceId,
      workspaceName: this.context.workspaceName,
      workbookId: this.context.workbookId,
      workbookName: this.context.workbookName,
      sheetId: String(this.sheet.id),
      sheetName: this.sheet.label,
      primaryLabel,
      preview,
    };
  }

  private defaultDisplayKey(): string | undefined {
    const keys = this.sheet.column_defs.map((c) => c.key);
    if (keys.includes("name")) return "name";
    return keys[0];
  }

  private formatPrimaryLabel(
    row: Record<string, unknown>,
    displayKey: string | undefined,
    rowId: RecordIdString,
  ): string {
    const raw = displayKey ? row[displayKey] : undefined;
    const value = raw == null || raw === "" ? rowId : String(jsonifyValue(raw));
    const prefix = this.context.workbookName
      ? `${this.context.workbookName} / ${this.sheet.label}`
      : this.sheet.label;
    return `${prefix} / ${value}`;
  }

  schemaFields(): TableSchemaField[] {
    const userFields: TableSchemaField[] = this.sheet.column_defs.map((col) => ({
      key: col.key,
      label: col.label || col.key,
      fieldType: col.field_type,
      nullable: col.required !== true,
      referenceTable: col.reference_table,
    }));
    return [
      ...userFields,
      { key: "id", label: "记录 ID", fieldType: "text", nullable: false },
      { key: "created_at", label: "创建时间", fieldType: "date", nullable: false },
      { key: "updated_at", label: "更新时间", fieldType: "date", nullable: false },
    ];
  }

  async queryRows(viewParams?: ViewParams): Promise<GridRow[]> {
    const columnsByKey = new Map(this.sheet.column_defs.map((c) => [c.key, c]));
    const validKeys = new Set(columnsByKey.keys());

    await assertDynamicTableExists(this.tableName);

    const compiled = compileSelectOnly(this.tableName, viewParams, columnsByKey);
    const result = await getLocalDb().query<[EntityRow[]]>(compiled);
    return (result[0] ?? []).map((row) => entityRowToDTO(row, validKeys));
  }

  async updateRows(
    rows: Array<{ id?: RecordIdString; values: Record<string, unknown> }>,
    workspace: RecordId,
    currentUserId: RecordId,
  ): Promise<GridRow[]> {
    await assertDynamicTableExists(this.tableName);
    await ensureEntityAuditFields(this.tableName);

    const validKeys = new Set(this.sheet.column_defs.map((c) => c.key));
    const columnsByKey = new Map(this.sheet.column_defs.map((c) => [c.key, storedColumnToDTO(c)]));
    const upserted: GridRow[] = [];

    for (const rowPatch of rows) {
      const cleanValues = encodeGridValues(rowPatch.values, columnsByKey, validKeys);

      if (rowPatch.id) {
        assertRowIdBelongsToTable(rowPatch.id, this.tableName);
        const updateValues = mapNullsToSurrealNone({ ...cleanValues, updated_at: new DateTime() });
        const row = await getLocalDb()
          .update<EntityRow>(new StringRecordId(rowPatch.id))
          .merge(updateValues);
        if (row) upserted.push(entityRowToDTO(row, validKeys));
      } else {
        const createValues = omitNullishInsertValues(cleanValues);
        createValues.workspace = workspace;
        createValues.created_by = currentUserId;
        const created = await getLocalDb()
          .create<EntityRow>(new Table(this.tableName))
          .content(createValues);
        const row = Array.isArray(created) ? created[0] : created;
        if (row) upserted.push(entityRowToDTO(row, validKeys));
      }
    }

    return upserted;
  }

  async applyColumnUpdate(columns: GridColumnDef[]): Promise<{ sheet: DataTableSheetRow; columns: GridColumnDef[] }> {
    if (columns.length === 0) {
      throw new ServiceError("VALIDATION_ERROR", "至少保留一个字段");
    }
    await assertDynamicTableExists(this.tableName);

    const normalized = columns.map(normalizeGridColumnDef);
    const seen = new Set<string>();
    for (const column of normalized) {
      if (seen.has(column.key)) {
        throw new ServiceError("VALIDATION_ERROR", `字段标识重复: ${column.key}`);
      }
      seen.add(column.key);
    }

    for (const column of normalized) {
      await overwriteEntityField(this.tableName, column);
    }

    const nextKeys = new Set(normalized.map((column) => column.key));
    for (const existing of this.sheet.column_defs) {
      if (!nextKeys.has(existing.key)) {
        await removeEntityField(this.tableName, existing.key);
      }
    }

    const storedDefs = normalized.map(gridColumnToStoredDef);
    const updated = await getLocalDb().query<[DataTableSheetRow[]]>(
      `UPDATE $sheetId SET column_defs = $columnDefs, updated_at = time::now() RETURN id, workbook, univer_id, table_name, label, position, column_defs`,
      { sheetId: this.sheet.id, columnDefs: storedDefs },
    );
    const updatedSheet = updated[0]?.[0];
    if (!updatedSheet) throw new ServiceError("INTERNAL_ERROR", "字段更新失败");
    return {
      sheet: updatedSheet,
      columns: updatedSheet.column_defs.map(storedColumnToDTO),
    };
  }

  async deleteRows(ids: RecordIdString[]): Promise<number> {
    await assertDynamicTableExists(this.tableName);
    let deleted = 0;
    for (const id of ids) {
      assertRowIdBelongsToTable(id, this.tableName);
      await getLocalDb().delete(new StringRecordId(id));
      deleted += 1;
    }
    return deleted;
  }
}

export function createDataTableRuntime(sheet: DataTableSheetRow): DataTableRuntime {
  return new DataTableRuntime(sheet);
}

export type ReferenceTargetItem = {
  runtime: DataTableRuntime;
  workspaceId?: string;
  workspaceName?: string;
  workbookId: string;
  workbookName?: string;
  sheetId: string;
  sheetLabel: string;
};

const ENTITY_TABLE_REGEX = /^ent_[a-z0-9_]+$/;

export function isEntityTableName(tableName: string): boolean {
  return ENTITY_TABLE_REGEX.test(tableName);
}

type SheetWithContextRow = DataTableSheetRow & {
  workbook_name?: string;
  workspace_id?: RecordId;
  workspace_name?: string;
};

function rowToContext(row: SheetWithContextRow): DataTableContext {
  return {
    workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,
    workspaceName: row.workspace_name,
    workbookId: String(row.workbook),
    workbookName: row.workbook_name,
  };
}

export namespace DataTableRuntime {
  export async function loadByTableName(tableName: string): Promise<DataTableRuntime | null> {
    assertEntityTableName(tableName);
    const db = getLocalDb();
    const rows = await db.query<[SheetWithContextRow[]]>(
      `SELECT
         id, workbook, univer_id, table_name, label, position, column_defs,
         workbook.name AS workbook_name,
         workbook.workspace AS workspace_id,
         workbook.workspace.name AS workspace_name
       FROM sheet WHERE table_name = $t LIMIT 1`,
      { t: tableName },
    );
    const row = rows[0]?.[0];
    if (!row) return null;
    return new DataTableRuntime(row, rowToContext(row));
  }

  export async function listAllForReference(): Promise<ReferenceTargetItem[]> {
    const db = getLocalDb();
    const rows = await db.query<[SheetWithContextRow[]]>(
      `SELECT
         id, workbook, univer_id, table_name, label, position, column_defs,
         workbook.name AS workbook_name,
         workbook.workspace AS workspace_id,
         workbook.workspace.name AS workspace_name
       FROM sheet ORDER BY workbook, position`,
    );
    const list = rows[0] ?? [];
    return list
      .filter((row) => ENTITY_TABLE_REGEX.test(row.table_name))
      .map((row) => {
        const context = rowToContext(row);
        return {
          runtime: new DataTableRuntime(row, context),
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          workbookId: context.workbookId!,
          workbookName: context.workbookName,
          sheetId: String(row.id),
          sheetLabel: row.label,
        };
      });
  }
}

export async function provisionEntityTable(tableName: string): Promise<void> {
  assertEntityTableName(tableName);
  await assertDdlOnline();
  await execTemplate("ent.create", { table_name: tableName });
  const db = getLocalDb();
  await db.query(buildEntityTableDdl(tableName));
}

export async function provisionRelationTable(tableName: string): Promise<void> {
  if (!/^rel_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的关系表名: ${tableName}`);
  }
  await assertDdlOnline();
  await execTemplate("rel.create", { table_name: tableName });
  const db = getLocalDb();
  await db.query(buildRelationTableDdl(tableName));
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
  await assertDdlOnline();
  await execTemplate("ent.field-remove", { table_name: tableName, field_name: key });
  const db = getLocalDb();
  await db.query(`REMOVE FIELD IF EXISTS ${key} ON TABLE ${tableName}`);
}

export async function createEntityRows(
  tableName: string,
  rows: Array<Record<string, unknown>>,
): Promise<RecordId[]> {
  assertEntityTableName(tableName);
  await assertDynamicTableExists(tableName);

  const createdIds: RecordId[] = [];
  for (const values of rows) {
    const created = await getLocalDb()
      .create<{ id: RecordId }>(new Table(tableName))
      .content(omitNullishInsertValues(values));
    const row = Array.isArray(created) ? created[0] : created;
    if (row?.id) createdIds.push(row.id);
  }
  return createdIds;
}

export function normalizeGridColumnDef(column: GridColumnDef): GridColumnDef {
  try {
    return normalizeSharedGridColumnDef(column);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServiceError("VALIDATION_ERROR", message);
  }
}

export function sheetRowToDTO(sheet: DataTableSheetRow): SheetSummaryDTO {
  return {
    id: String(sheet.id),
    workbookId: String(sheet.workbook),
    univerId: sheet.univer_id,
    tableName: sheet.table_name,
    label: sheet.label,
    position: sheet.position,
    columnDefs: sheet.column_defs.map(storedColumnToDTO),
  };
}

export function omitNullishInsertValues(values: Record<string, unknown>): Record<string, unknown> {
  return omitNullishSurrealFields(values);
}

export function assertEntityTableName(tableName: string): void {
  if (!/^ent_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的实体表名: ${tableName}`);
  }
}

export type DynamicTableNameInput = {
  workspaceId: string;
  workbookId: string;
  suffix?: string;
};

function wsKeyPart(workspaceId: string): string {
  return workspaceId.replace(/^workspace:/, "").slice(0, 8);
}

function wbKeyPart(workbookId: string): string {
  return workbookId.replace(/^workbook:/, "").slice(0, 8);
}

export function generateEntityTableName(input: DynamicTableNameInput): string {
  const base = `ent_${wsKeyPart(input.workspaceId)}_${wbKeyPart(input.workbookId)}`;
  return input.suffix ? `${base}_${input.suffix}` : base;
}

export function generateRelationTableName(input: DynamicTableNameInput & { suffix: string }): string {
  return `rel_${wsKeyPart(input.workspaceId)}_${wbKeyPart(input.workbookId)}_${input.suffix}`;
}

export function assertRowIdBelongsToTable(rowId: string, tableName: string): void {
  if (!rowId.startsWith(`${tableName}:`)) {
    throw new ServiceError("NOT_FOUND", "记录不属于当前 Sheet");
  }
}

export async function assertDynamicTableExists(tableName: string): Promise<void> {
  const db = getLocalDb();
  const info = await db.query<[{ tables?: Record<string, unknown> }]>(`INFO FOR DB`);
  const tables = info[0]?.tables ?? {};
  if (!Object.prototype.hasOwnProperty.call(tables, tableName)) {
    throw new ServiceError("NOT_FOUND", `动态实体表不存在: ${tableName}`);
  }
}

function encodeGridValues(
  values: Record<string, unknown>,
  columnsByKey: Map<string, GridColumnDef>,
  validKeys: Set<string>,
): Record<string, unknown> {
  const cleanValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!validKeys.has(key)) continue;
    const column = columnsByKey.get(key);
    cleanValues[key] = coerceGridFieldValue(value, column);
  }

  for (const column of columnsByKey.values()) {
    const fieldErrors = validateGridFieldValue(cleanValues[column.key], column);
    if (fieldErrors.length) {
      throw new ServiceError("VALIDATION_ERROR", `${column.label}: ${fieldErrors[0]}`);
    }
  }

  for (const column of columnsByKey.values()) {
    if (column.fieldType !== "date") continue;
    const value = cleanValues[column.key];
    if (value instanceof Date) cleanValues[column.key] = new DateTime(value);
  }

  for (const column of columnsByKey.values()) {
    if (column.fieldType !== "reference") continue;
    const value = cleanValues[column.key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      cleanValues[column.key] = value.map((item) => typeof item === "string" ? new StringRecordId(item) : item);
    } else if (typeof value === "string") {
      cleanValues[column.key] = new StringRecordId(value);
    }
  }

  return cleanValues;
}

export function buildEntityTableDdl(tableName: string): string {
  assertEntityTableName(tableName);
  return `DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS CHANGEFEED 7d PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_by ON TABLE ${tableName} TYPE option<record<app_user>>;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     ${buildOriginSessionDdl(tableName)}`;
}

export function buildRelationTableDdl(tableName: string): string {
  if (!/^rel_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的关系表名: ${tableName}`);
  }
  return `DEFINE TABLE IF NOT EXISTS ${tableName} TYPE RELATION SCHEMALESS CHANGEFEED 7d PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     ${buildOriginSessionDdl(tableName)}`;
}

export function buildOriginSessionDdl(tableName: string): string {
  return `DEFINE FIELD OVERWRITE _origin_session_id ON TABLE ${tableName} TYPE option<string>
       DEFAULT ALWAYS ($current_session_id ?? NONE);
     REMOVE EVENT IF EXISTS ${tableName}_origin_session ON TABLE ${tableName};`;
}

export function buildEntityFieldDdl(
  tableName: string,
  column: GridColumnDef,
  mode: "if-not-exists" | "overwrite",
): string {
  assertEntityTableName(tableName);
  let schema;
  try {
    schema = buildSurrealFieldSchema(column);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServiceError("VALIDATION_ERROR", message);
  }
  const clause = mode === "overwrite" ? "OVERWRITE" : "IF NOT EXISTS";
  return `DEFINE FIELD ${clause} ${schema.fieldName} ON TABLE ${tableName} TYPE ${schema.type}${schema.assert}`;
}

async function defineEntityField(tableName: string, column: GridColumnDef, mode: "if-not-exists" | "overwrite"): Promise<void> {
  assertEntityTableName(tableName);
  let schema;
  try {
    schema = buildSurrealFieldSchema(column);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServiceError("VALIDATION_ERROR", message);
  }
  const templateId = mode === "overwrite" ? "ent.field-overwrite" : "ent.field-add";
  await assertDdlOnline();
  await execTemplate(templateId, {
    table_name: tableName,
    field_name: schema.fieldName,
    field_type: schema.type,
    ...(schema.assert ? { field_assert: schema.assert.trim() } : {}),
  });
  const db = getLocalDb();
  return db.query(buildEntityFieldDdl(tableName, column, mode)).then(() => undefined);
}

async function assertDdlOnline(): Promise<void> {
  assertCapabilityAllowed(getServiceContext().capabilities, "write_shared_structure_ddl");
}

/**
 * 编译数据表读路径查询。函数体永远以 `SELECT * FROM type::table($t)` 开头,
 * 物理上只能产生 SELECT 语句 —— 这是出路 3 的"受控字符串"边界。
 * WHERE 子句委托 SDK 表达式工具构造,bindings 由 SDK 自动管理。
 */
export function compileSelectOnly(
  tableName: string,
  viewParams: ViewParams | undefined,
  columnsByKey: Map<string, StoredColumnDef>,
): BoundQuery {
  const filterExprs: Expr[] = [];
  for (const clause of viewParams?.filters ?? []) {
    const column = columnsByKey.get(clause.key);
    if (!column || !isSafeIdentifier(clause.key)) continue;
    const built = filterClauseToExpr(clause, column);
    if (built) filterExprs.push(built);
  }

  const combine = viewParams?.filterMode === "or" ? or : and;
  const whereExpr: ExprLike = filterExprs.length ? combine(...filterExprs) : null;

  const query = new BoundQuery(`SELECT * FROM type::table($t)`, { t: tableName });
  if (whereExpr) {
    query.append(` WHERE `).append(expr(whereExpr));
  }

  const orderBy = compileOrderBy(viewParams?.sorts, columnsByKey);
  if (orderBy) query.append(` ORDER BY ${orderBy}`);

  query.append(` LIMIT 5000`);
  return query;
}

function filterClauseToExpr(clause: FilterClause, column: StoredColumnDef): Expr | null {
  switch (clause.op) {
    case "is_null":
      return raw(`${clause.key} IS NULL`);
    case "is_not_null":
      return raw(`${clause.key} IS NOT NULL`);
    case "in": {
      const arr = Array.isArray(clause.value) ? clause.value : [];
      if (arr.length === 0) return null;
      return inside(clause.key, arr.map((v) => coerceFilterValue(v, column)));
    }
    default: {
      if (clause.value === undefined || clause.value === null || clause.value === "") return null;
      const value = coerceFilterValue(clause.value, column);
      switch (clause.op) {
        case "eq": return eq(clause.key, value);
        case "neq": return ne(clause.key, value);
        case "gt": return gt(clause.key, value);
        case "gte": return gte(clause.key, value);
        case "lt": return lt(clause.key, value);
        case "lte": return lte(clause.key, value);
        case "contains": return contains(clause.key, value);
        case "not_contains": return not(contains(clause.key, value));
      }
    }
  }
  return null;
}

function compileOrderBy(
  sorts: SortClause[] | undefined,
  columnsByKey: Map<string, StoredColumnDef>,
): string {
  const pieces: string[] = [];
  for (const sort of sorts ?? []) {
    if (!columnsByKey.has(sort.key) || !isSafeIdentifier(sort.key)) continue;
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    pieces.push(`${sort.key} ${dir}`);
  }
  return pieces.join(", ");
}

function coerceFilterValue(value: unknown, column: StoredColumnDef): unknown {
  const coerced = coerceGridFieldValue(value, storedColumnToDTO(column));
  if (column.field_type === "date" && coerced instanceof Date) {
    return new DateTime(coerced);
  }
  return coerced;
}

function entityRowToDTO(row: EntityRow, validKeys: Set<string>): GridRow {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "id" || key === "workspace" || key === "created_by" || key === "created_at" || key === "updated_at") continue;
    if (validKeys.has(key)) values[key] = value;
  }
  return { id: String(row.id), values };
}

async function ensureEntityAuditFields(tableName: string): Promise<void> {
  assertEntityTableName(tableName);
  const db = getLocalDb();
  await db.query(
    `DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_by ON TABLE ${tableName} TYPE option<record<app_user>>;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`,
  );
}

function isSafeIdentifier(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

function assertEntityFieldName(key: string): void {
  if (!ENTITY_FIELD_NAME.test(key) || RESERVED_ENTITY_FIELDS.has(key)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的字段标识: ${key}`);
  }
}

function jsonifyValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return String(value);
  if (Array.isArray(value)) return value.map(jsonifyValue);
  if (value && typeof value === "object" && "toISOString" in value && typeof (value as { toISOString: unknown }).toISOString === "function") {
    return (value as { toISOString: () => string }).toISOString();
  }
  return value;
}
