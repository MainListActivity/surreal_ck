import type { GridColumnDef, GridFieldConstraints } from "./rpc.types";
import { DEFAULT_DATE_FORMAT } from "./date-format";

const INTEGER_EPSILON = 1e-9;
const ENTITY_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_ENTITY_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);
const REFERENCE_SYSTEM_TABLES = new Set(["app_user"]);
const REFERENCE_ENTITY_TABLE = /^ent_[a-z0-9_]+$/;

export const GRID_FIELD_TYPE_OPTIONS = [
  { value: "text", label: "文本", icon: "textType" },
  { value: "single_select", label: "单选", icon: "list" },
  { value: "number", label: "数字", icon: "hash" },
  { value: "decimal", label: "金额/小数", icon: "coins" },
  { value: "date", label: "日期", icon: "calendar" },
  { value: "checkbox", label: "勾选", icon: "checkSquare" },
  { value: "reference", label: "引用", icon: "link" },
] as const;

export type GridFieldType = typeof GRID_FIELD_TYPE_OPTIONS[number]["value"];

export type GridFieldDraft = GridColumnDef & {
  optionsText?: string;
  constraints: GridFieldConstraints;
};

export type StoredGridFieldDef = {
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

export type SurrealFieldSchema = {
  fieldName: string;
  type: string;
  assert: string;
};

export function buildGridFieldDraft(column: GridColumnDef): GridFieldDraft {
  return {
    ...column,
    optionsText: column.options?.join("\n") ?? "",
    constraints: { ...column.constraints },
    dateFormat: column.dateFormat?.trim() || DEFAULT_DATE_FORMAT,
  };
}

export function commitGridFieldDraft(field: GridFieldDraft, strict = true): GridColumnDef {
  const options = field.fieldType === "single_select"
    ? (field.optionsText ?? "").split("\n").map((opt) => opt.trim()).filter(Boolean)
    : undefined;

  let constraints: GridFieldConstraints | undefined;
  try {
    constraints = normalizeGridFieldConstraints(field.fieldType, field.constraints);
  } catch (err) {
    if (strict) throw err;
    constraints = undefined;
  }

  return normalizeGridColumnDef({
    key: field.key,
    label: field.label,
    fieldType: field.fieldType,
    required: field.required,
    options,
    constraints,
    dateFormat: field.fieldType === "date" ? (field.dateFormat?.trim() || DEFAULT_DATE_FORMAT) : undefined,
    referenceTable: field.fieldType === "reference" ? field.referenceTable : undefined,
    referenceSheetId: field.fieldType === "reference" ? field.referenceSheetId : undefined,
    referenceMultiple: field.fieldType === "reference" ? field.referenceMultiple : undefined,
    referenceDisplayKey: field.fieldType === "reference" ? field.referenceDisplayKey : undefined,
  });
}

export function normalizeGridColumnDef(column: GridColumnDef): GridColumnDef {
  const key = column.key.trim();
  assertEntityFieldName(key);

  const label = column.label.trim();
  if (!label) throw new Error("字段名称不能为空");
  if (label.length > 80) throw new Error("字段名称过长");

  const fieldType = normalizeFieldType(column.fieldType);
  const options = fieldType === "single_select"
    ? [...new Set((column.options ?? []).map((opt) => opt.trim()).filter(Boolean))].slice(0, 80)
    : undefined;
  const constraints = normalizeGridFieldConstraints(fieldType, column.constraints);
  const dateFormat = fieldType === "date" ? normalizeDateFormat(column.dateFormat) : undefined;

  let referenceTable: string | undefined;
  let referenceSheetId: string | undefined;
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

export function gridColumnToStoredDef(column: GridColumnDef): StoredGridFieldDef {
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

export function storedColumnToDTO(column: StoredGridFieldDef): GridColumnDef {
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

export function buildSurrealFieldSchema(column: GridColumnDef): SurrealFieldSchema {
  const normalized = normalizeGridColumnDef(column);
  return {
    fieldName: normalized.key,
    type: surrealTypeForField(normalized),
    assert: surrealAssertForField(normalized),
  };
}

export function normalizeGridFieldConstraints(
  fieldType: string,
  constraints?: GridFieldConstraints,
): GridFieldConstraints | undefined {
  if (!constraints) return undefined;

  const next: GridFieldConstraints = {};

  switch (fieldType) {
    case "text": {
      const minLength = normalizeIntegerConstraint(constraints.minLength, "最小长度");
      const maxLength = normalizeIntegerConstraint(constraints.maxLength, "最大长度");
      if (minLength !== undefined) next.minLength = minLength;
      if (maxLength !== undefined) next.maxLength = maxLength;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        throw new Error("文本字段的最小长度不能大于最大长度");
      }
      break;
    }
    case "single_select": {
      const maxLength = normalizeIntegerConstraint(constraints.maxLength, "选项最大长度");
      if (maxLength !== undefined) next.maxLength = maxLength;
      break;
    }
    case "number":
    case "decimal": {
      const min = normalizeNumberConstraint(constraints.min, "最小值");
      const max = normalizeNumberConstraint(constraints.max, "最大值");
      const step = normalizePositiveNumberConstraint(constraints.step, "步长");
      if (min !== undefined) next.min = min;
      if (max !== undefined) next.max = max;
      if (step !== undefined) next.step = step;
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error("数值字段的最小值不能大于最大值");
      }
      break;
    }
    case "date": {
      const minDate = normalizeDateConstraint(constraints.minDate, "最早日期");
      const maxDate = normalizeDateConstraint(constraints.maxDate, "最晚日期");
      if (minDate) next.minDate = minDate;
      if (maxDate) next.maxDate = maxDate;
      if (minDate && maxDate && new Date(minDate).getTime() > new Date(maxDate).getTime()) {
        throw new Error("日期字段的最早日期不能晚于最晚日期");
      }
      break;
    }
    case "checkbox":
      break;
    case "reference":
      break;
    default:
      throw new Error(`不支持的字段类型: ${fieldType}`);
  }

  return Object.keys(next).length ? next : undefined;
}

const RECORD_ID_PATTERN = /^[a-z_][a-z0-9_]*:[A-Za-z0-9_⟨⟩]+$/;

export function isRecordIdString(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

/** 校验 RecordId 字符串属于指定目标表（app_user 或 ent_xxx）。 */
export function recordIdBelongsToTable(value: unknown, table: string): boolean {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  return value.slice(0, colon) === table;
}

export function coerceGridFieldValue(value: unknown, column?: GridColumnDef): unknown {
  if (!column) return value;
  if (value === "" || value === undefined || value === null) return null;

  switch (column.fieldType) {
    case "number":
    case "decimal": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "checkbox":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "y", "on", "是"].includes(normalized)) return true;
        if (["false", "0", "no", "n", "off", "否"].includes(normalized)) return false;
      }
      return Boolean(value);
    case "date": {
      if (value instanceof Date) return value;
      if (typeof value === "string" || typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date;
      }
      return value;
    }
    case "reference": {
      // 多选：把 array 项规整为字符串数组并去重；空数组返回 null。
      if (column.referenceMultiple) {
        if (!Array.isArray(value)) {
          if (typeof value === "string" && value.length) return [value];
          return null;
        }
        const ids = Array.from(new Set(
          value
            .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
            .filter((s) => s.length > 0),
        ));
        return ids.length ? ids : null;
      }
      // 单选：标准化为字符串；空数组退化为 null。
      if (Array.isArray(value)) {
        const first = value.find((v) => typeof v === "string" && v.length > 0);
        return typeof first === "string" ? first : null;
      }
      return typeof value === "string" ? value : String(value);
    }
    default:
      return typeof value === "string" ? value : String(value);
  }
}

export function validateGridFieldValue(value: unknown, column: GridColumnDef): string[] {
  const errors: string[] = [];
  const constraints = normalizeGridFieldConstraints(column.fieldType, column.constraints);
  const empty =
    value === undefined ||
    value === null ||
    value === "" ||
    (column.fieldType === "reference" && Array.isArray(value) && value.length === 0);

  if (empty) {
    if (column.required) errors.push("必填");
    return errors;
  }

  switch (column.fieldType) {
    case "text": {
      const text = String(value);
      if (constraints?.minLength !== undefined && text.length < constraints.minLength) {
        errors.push(`至少 ${constraints.minLength} 个字符`);
      }
      if (constraints?.maxLength !== undefined && text.length > constraints.maxLength) {
        errors.push(`最多 ${constraints.maxLength} 个字符`);
      }
      break;
    }
    case "single_select": {
      const text = String(value);
      if (column.options?.length && !column.options.includes(text)) {
        errors.push("必须选择预定义选项");
      }
      if (constraints?.maxLength !== undefined && text.length > constraints.maxLength) {
        errors.push(`选项文本最多 ${constraints.maxLength} 个字符`);
      }
      break;
    }
    case "number":
    case "decimal": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        errors.push("必须是数字");
        break;
      }
      if (column.fieldType === "number" && !Number.isInteger(n)) {
        errors.push("必须是整数");
      }
      if (constraints?.min !== undefined && n < constraints.min) {
        errors.push(`不能小于 ${constraints.min}`);
      }
      if (constraints?.max !== undefined && n > constraints.max) {
        errors.push(`不能大于 ${constraints.max}`);
      }
      if (constraints?.step !== undefined) {
        const base = constraints.min ?? 0;
        const quotient = (n - base) / constraints.step;
        if (Math.abs(Math.round(quotient) - quotient) > INTEGER_EPSILON) {
          errors.push(`必须按 ${constraints.step} 的步长变化`);
        }
      }
      break;
    }
    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        errors.push("日期格式无效");
        break;
      }
      const time = date.getTime();
      if (constraints?.minDate && time < new Date(constraints.minDate).getTime()) {
        errors.push(`不能早于 ${formatDateLabel(constraints.minDate)}`);
      }
      if (constraints?.maxDate && time > new Date(constraints.maxDate).getTime()) {
        errors.push(`不能晚于 ${formatDateLabel(constraints.maxDate)}`);
      }
      break;
    }
    case "checkbox":
      if (typeof value !== "boolean") errors.push("必须是布尔值");
      break;
    case "reference": {
      const target = column.referenceTable;
      if (!target) {
        errors.push("引用字段未配置目标表");
        break;
      }
      const ids = column.referenceMultiple
        ? (Array.isArray(value) ? value : [value])
        : [value];
      for (const id of ids) {
        if (!isRecordIdString(id)) {
          errors.push("引用值不是合法 RecordId");
          break;
        }
        if (!recordIdBelongsToTable(id, target)) {
          errors.push(`引用值必须属于 ${target}`);
          break;
        }
      }
      break;
    }
    default:
      errors.push(`不支持的字段类型: ${column.fieldType}`);
  }

  return errors;
}

export function summarizeGridField(column: GridColumnDef): string[] {
  const summary: string[] = [];
  const constraints = normalizeGridFieldConstraints(column.fieldType, column.constraints);

  if (column.required) summary.push("必填");

  switch (column.fieldType) {
    case "text":
      if (constraints?.minLength !== undefined || constraints?.maxLength !== undefined) {
        summary.push([
          constraints.minLength !== undefined ? `${constraints.minLength}` : "0",
          constraints.maxLength !== undefined ? `${constraints.maxLength}` : "∞",
        ].join(" - ") + " 字符");
      }
      break;
    case "single_select":
      if (column.options?.length) summary.push(`${column.options.length} 个选项`);
      break;
    case "number":
    case "decimal":
      if (constraints?.min !== undefined) summary.push(`最小 ${constraints.min}`);
      if (constraints?.max !== undefined) summary.push(`最大 ${constraints.max}`);
      if (constraints?.step !== undefined) summary.push(`步长 ${constraints.step}`);
      if (column.fieldType === "number") summary.push("整数");
      break;
    case "date":
      if (constraints?.minDate) summary.push(`起始 ${formatDateLabel(constraints.minDate)}`);
      if (constraints?.maxDate) summary.push(`截止 ${formatDateLabel(constraints.maxDate)}`);
      break;
    case "checkbox":
      summary.push("是 / 否");
      break;
    case "reference":
      summary.push(column.referenceMultiple ? "多选引用" : "单引用");
      break;
  }

  return summary;
}

export function normalizeDateInputValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function normalizeReferenceTable(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("引用字段必须配置目标表");
  }
  const trimmed = value.trim();
  if (REFERENCE_SYSTEM_TABLES.has(trimmed)) return trimmed;
  if (REFERENCE_ENTITY_TABLE.test(trimmed)) return trimmed;
  throw new Error(`非法的引用目标表: ${trimmed}`);
}

export function normalizeDateFormat(format: string | undefined | null): string | undefined {
  if (format === undefined || format === null) return undefined;
  const trimmed = format.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 64) throw new Error("日期格式过长");
  return trimmed;
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
        throw new Error(`不支持的字段类型: ${column.fieldType}`);
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

function normalizeReferenceDisplayKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(trimmed)) {
    throw new Error(`非法的展示字段: ${trimmed}`);
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
      throw new Error(`不支持的字段类型: ${fieldType}`);
  }
}

function assertEntityFieldName(key: string): void {
  if (!ENTITY_FIELD_NAME.test(key) || RESERVED_ENTITY_FIELDS.has(key)) {
    throw new Error(`无效的字段标识: ${key}`);
  }
}

function normalizeIntegerConstraint(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label}必须是大于等于 0 的整数`);
  }
  return n;
}

function normalizeNumberConstraint(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label}必须是数字`);
  }
  return n;
}

function normalizePositiveNumberConstraint(value: unknown, label: string): number | undefined {
  const n = normalizeNumberConstraint(value, label);
  if (n === undefined) return undefined;
  if (n <= 0) throw new Error(`${label}必须大于 0`);
  return n;
}

function normalizeDateConstraint(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label}格式无效`);
  }
  return date.toISOString();
}

function formatDateLabel(value: string): string {
  return value.slice(0, 10);
}
