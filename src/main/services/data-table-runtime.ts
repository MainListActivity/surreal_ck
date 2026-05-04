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
import { ServiceError } from "./errors";
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
  SheetSummaryDTO,
  SortClause,
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

type EntityRow = Record<string, unknown> & { id: RecordId; workspace?: RecordId };
const ENTITY_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_ENTITY_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

export class DataTableRuntime {
  readonly sheet: DataTableSheetRow;

  constructor(sheet: DataTableSheetRow) {
    assertEntityTableName(sheet.table_name);
    this.sheet = sheet;
  }

  get tableName(): string {
    return this.sheet.table_name;
  }

  get columns(): GridColumnDef[] {
    return this.sheet.column_defs.map(storedColumnToDTO);
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

export async function provisionEntityTable(tableName: string): Promise<void> {
  assertEntityTableName(tableName);
  const db = getLocalDb();
  await db.query(
    `DEFINE TABLE IF NOT EXISTS ${tableName} SCHEMALESS PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS workspace  ON TABLE ${tableName} TYPE option<record<workspace>>;
     DEFINE FIELD IF NOT EXISTS created_by ON TABLE ${tableName} TYPE option<record<app_user>>;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();
     DEFINE FIELD IF NOT EXISTS updated_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`,
  );
}

export async function provisionRelationTable(tableName: string): Promise<void> {
  if (!/^rel_[a-z0-9_]+$/.test(tableName)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的关系表名: ${tableName}`);
  }
  const db = getLocalDb();
  await db.query(
    `DEFINE TABLE IF NOT EXISTS ${tableName} TYPE RELATION SCHEMALESS PERMISSIONS FULL;
     DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableName} TYPE datetime VALUE time::now();`,
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

function defineEntityField(tableName: string, column: GridColumnDef, mode: "if-not-exists" | "overwrite"): Promise<void> {
  assertEntityTableName(tableName);
  let schema;
  try {
    schema = buildSurrealFieldSchema(column);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServiceError("VALIDATION_ERROR", message);
  }
  const clause = mode === "overwrite" ? "OVERWRITE" : "IF NOT EXISTS";
  const db = getLocalDb();
  return db.query(
    `DEFINE FIELD ${clause} ${schema.fieldName} ON TABLE ${tableName} TYPE ${schema.type}${schema.assert}`,
  ).then(() => undefined);
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
