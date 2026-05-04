import { DateTime, RecordId, StringRecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import { mapNullsToSurrealNone, omitNullishSurrealFields } from "../db/surreal-values";
import { ServiceError } from "./errors";
import { coerceGridFieldValue, normalizeGridFieldConstraints, validateGridFieldValue } from "../../shared/field-schema";
import type {
  FilterClause,
  GridColumnDef,
  GridRow,
  RecordIdString,
  SheetSummaryDTO,
  SortClause,
  ViewParams,
} from "../../shared/rpc.types";

export type StoredColumnDef = {
  key: string;
  label: string;
  field_type: string;
  required?: boolean;
  options?: string[];
  constraints?: GridColumnDef["constraints"];
  date_format?: string;
  reference_table?: string;
  reference_sheet_id?: string;
  reference_multiple?: boolean;
  reference_display_key?: string;
};

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
  const key = column.key.trim();
  assertEntityFieldName(key);

  const label = column.label.trim();
  if (!label) throw new ServiceError("VALIDATION_ERROR", "字段名称不能为空");
  if (label.length > 80) throw new ServiceError("VALIDATION_ERROR", "字段名称过长");

  const fieldType = normalizeFieldType(column.fieldType);
  const options = fieldType === "single_select"
    ? [...new Set((column.options ?? []).map((opt) => opt.trim()).filter(Boolean))].slice(0, 80)
    : undefined;
  const constraints = normalizeGridFieldConstraints(fieldType, column.constraints);
  const dateFormat = fieldType === "date" ? normalizeDateFormat(column.dateFormat) : undefined;

  let referenceTable: string | undefined;
  let referenceSheetId: RecordIdString | undefined;
  let referenceMultiple: boolean | undefined;
  let referenceDisplayKey: string | undefined;
  if (fieldType === "reference") {
    referenceTable = normalizeReferenceTable(column.referenceTable);
    referenceSheetId = column.referenceSheetId?.trim() || undefined;
    referenceMultiple = Boolean(column.referenceMultiple);
    referenceDisplayKey = normalizeReferenceDisplayKey(column.referenceDisplayKey);
  }

  return {
    key,
    label,
    fieldType,
    required: Boolean(column.required),
    options,
    constraints,
    dateFormat,
    referenceTable,
    referenceSheetId,
    referenceMultiple,
    referenceDisplayKey,
  };
}

export function gridColumnToStoredDef(column: GridColumnDef): StoredColumnDef {
  return {
    key: column.key,
    label: column.label,
    field_type: column.fieldType,
    required: column.required,
    options: column.options,
    constraints: column.constraints,
    date_format: column.dateFormat,
    reference_table: column.referenceTable,
    reference_sheet_id: column.referenceSheetId,
    reference_multiple: column.referenceMultiple,
    reference_display_key: column.referenceDisplayKey,
  };
}

export function storedColumnToDTO(column: StoredColumnDef): GridColumnDef {
  return {
    key: column.key,
    label: column.label,
    fieldType: column.field_type,
    required: column.required,
    options: column.options,
    constraints: column.constraints,
    dateFormat: column.date_format,
    referenceTable: column.reference_table,
    referenceSheetId: column.reference_sheet_id,
    referenceMultiple: column.reference_multiple,
    referenceDisplayKey: column.reference_display_key,
  };
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
  const normalized = normalizeGridColumnDef(column);
  const clause = mode === "overwrite" ? "OVERWRITE" : "IF NOT EXISTS";
  const surrealType = surrealTypeForField(normalized);
  const assertClause = surrealAssertForField(normalized);
  const db = getLocalDb();
  return db.query(
    `DEFINE FIELD ${clause} ${normalized.key} ON TABLE ${tableName} TYPE ${surrealType}${assertClause}`,
  ).then(() => undefined);
}

function surrealTypeForField(column: GridColumnDef): string {
  const baseType = (() => {
    switch (column.fieldType) {
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
      case "reference": {
        const target = normalizeReferenceTable(column.referenceTable);
        const recordType = `record<${target}>`;
        return column.referenceMultiple ? `array<${recordType}>` : recordType;
      }
      default:
        throw new ServiceError("VALIDATION_ERROR", `不支持的字段类型: ${column.fieldType}`);
    }
  })();
  return column.required ? baseType : `option<${baseType}>`;
}

function surrealAssertForField(column: GridColumnDef): string {
  const rules: string[] = [];
  const constraints = column.constraints;

  if (column.fieldType === "single_select" && column.options?.length) {
    const options = column.options.map((option) => JSON.stringify(option)).join(", ");
    rules.push(`$value INSIDE [${options}]`);
  }
  if (column.fieldType === "text") {
    if (constraints?.minLength !== undefined) rules.push(`string::len($value) >= ${constraints.minLength}`);
    if (constraints?.maxLength !== undefined) rules.push(`string::len($value) <= ${constraints.maxLength}`);
  }
  if (column.fieldType === "single_select" && constraints?.maxLength !== undefined) {
    rules.push(`string::len($value) <= ${constraints.maxLength}`);
  }
  if (column.fieldType === "number" || column.fieldType === "decimal") {
    if (column.fieldType === "number") rules.push(`math::floor($value) = $value`);
    if (constraints?.min !== undefined) rules.push(`$value >= ${constraints.min}`);
    if (constraints?.max !== undefined) rules.push(`$value <= ${constraints.max}`);
    if (constraints?.step !== undefined) {
      const base = constraints.min ?? 0;
      rules.push(`math::floor((($value - ${base}) / ${constraints.step})) = (($value - ${base}) / ${constraints.step})`);
    }
  }
  if (column.fieldType === "date") {
    if (constraints?.minDate) rules.push(`$value >= d'${constraints.minDate}'`);
    if (constraints?.maxDate) rules.push(`$value <= d'${constraints.maxDate}'`);
  }

  if (!rules.length) return "";
  const body = rules.join(" AND ");
  return column.required ? ` ASSERT ${body}` : ` ASSERT $value = NONE OR (${body})`;
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

function normalizeDateFormat(format: string | undefined | null): string | undefined {
  if (format === undefined || format === null) return undefined;
  const trimmed = format.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 64) throw new ServiceError("VALIDATION_ERROR", "日期格式过长");
  return trimmed;
}

const REFERENCE_SYSTEM_TABLES = new Set(["app_user"]);
const REFERENCE_ENTITY_TABLE = /^ent_[a-z0-9_]+$/;

export function normalizeReferenceTable(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new ServiceError("VALIDATION_ERROR", "引用字段必须配置目标表");
  }
  const trimmed = value.trim();
  if (REFERENCE_SYSTEM_TABLES.has(trimmed)) return trimmed;
  if (REFERENCE_ENTITY_TABLE.test(trimmed)) return trimmed;
  throw new ServiceError("VALIDATION_ERROR", `非法的引用目标表: ${trimmed}`);
}

function normalizeReferenceDisplayKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(trimmed)) {
    throw new ServiceError("VALIDATION_ERROR", `非法的展示字段: ${trimmed}`);
  }
  return trimmed;
}

function normalizeFieldType(fieldType: string): string {
  switch (fieldType) {
    case "text":
    case "single_select":
    case "number":
    case "decimal":
    case "date":
    case "checkbox":
    case "reference":
      return fieldType;
    default:
      throw new ServiceError("VALIDATION_ERROR", `不支持的字段类型: ${fieldType}`);
  }
}

function assertEntityFieldName(key: string): void {
  if (!ENTITY_FIELD_NAME.test(key) || RESERVED_ENTITY_FIELDS.has(key)) {
    throw new ServiceError("VALIDATION_ERROR", `无效的字段标识: ${key}`);
  }
}

function isSafeIdentifier(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}
