import type { GridColumnDef, GridFieldConstraints } from "./rpc.types";

const INTEGER_EPSILON = 1e-9;

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
    default:
      throw new Error(`不支持的字段类型: ${fieldType}`);
  }

  return Object.keys(next).length ? next : undefined;
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
    default:
      return typeof value === "string" ? value : String(value);
  }
}

export function validateGridFieldValue(value: unknown, column: GridColumnDef): string[] {
  const errors: string[] = [];
  const constraints = normalizeGridFieldConstraints(column.fieldType, column.constraints);
  const empty = value === undefined || value === null || value === "";

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
  }

  return summary;
}

export function normalizeDateInputValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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
