import { DateTime, RecordId, StringRecordId } from "surrealdb";
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

    const compiled = compileViewQuery(viewParams, columnsByKey);
    const sql =
      `SELECT * FROM type::table($t)` +
      (compiled.where ? ` WHERE ${compiled.where}` : "") +
      (compiled.orderBy ? ` ORDER BY ${compiled.orderBy}` : "") +
      ` LIMIT 5000`;

    const db = getLocalDb();
    const result = await db.query<[EntityRow[]]>(sql, {
      t: this.tableName,
      ...compiled.bindings,
    });
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
        const updated = await getLocalDb().query<[EntityRow[]]>(
          `UPDATE $rowId MERGE $vals`,
          { rowId: new StringRecordId(rowPatch.id), vals: updateValues },
        );
        const row = updated[0]?.[0];
        if (row) upserted.push(entityRowToDTO(row, validKeys));
      } else {
        const createValues = omitNullishInsertValues(cleanValues);
        createValues.workspace = workspace;
        createValues.created_by = currentUserId;
        const created = await getLocalDb().query<[EntityRow[]]>(
          `CREATE type::table($t) CONTENT $vals`,
          { t: this.tableName, vals: createValues },
        );
        const row = created[0]?.[0];
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
      await getLocalDb().query(`DELETE $rowId`, { rowId: new StringRecordId(id) });
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
    const created = await getLocalDb().query<[{ id: RecordId }[]]>(
      `CREATE type::table($t) CONTENT $vals RETURN id`,
      { t: tableName, vals: omitNullishInsertValues(values) },
    );
    const id = created[0]?.[0]?.id;
    if (id) createdIds.push(id);
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

const FILTER_OP_TO_SQL: Record<FilterClause["op"], { sql: string; needValue: "scalar" | "array" | "none" }> = {
  eq: { sql: "=", needValue: "scalar" },
  neq: { sql: "!=", needValue: "scalar" },
  gt: { sql: ">", needValue: "scalar" },
  gte: { sql: ">=", needValue: "scalar" },
  lt: { sql: "<", needValue: "scalar" },
  lte: { sql: "<=", needValue: "scalar" },
  contains: { sql: "CONTAINS", needValue: "scalar" },
  not_contains: { sql: "CONTAINSNOT", needValue: "scalar" },
  in: { sql: "INSIDE", needValue: "array" },
  is_null: { sql: "IS NULL", needValue: "none" },
  is_not_null: { sql: "IS NOT NULL", needValue: "none" },
};

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
    if (!column || !isSafeIdentifier(clause.key)) continue;

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
    if (!columnsByKey.has(sort.key) || !isSafeIdentifier(sort.key)) continue;
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderPieces.push(`${sort.key} ${dir}`);
  }

  return { where, orderBy: orderPieces.join(", "), bindings };
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
    if (validKeys.has(key)) values[key] = jsonifyDbValue(value);
  }
  return { id: String(row.id), values };
}

function jsonifyDbValue(value: unknown): unknown {
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return String(value);
  if (Array.isArray(value)) return value.map(jsonifyDbValue);
  return value;
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
