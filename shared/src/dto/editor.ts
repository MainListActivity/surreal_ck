import type { ISODateTimeString, RecordIdString } from "./transport";

// ─── Editor DTOs ──────────────────────────────────────────────────────────────

export type GridFieldConstraints = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  minDate?: ISODateTimeString;
  maxDate?: ISODateTimeString;
};

export type GridColumnDef = {
  key: string;
  label: string;
  fieldType: string;
  required?: boolean;
  options?: string[];
  constraints?: GridFieldConstraints;
  /** 仅 fieldType === "date" 有效；dayjs 格式串，例如 "YYYY-MM-DD HH:mm:ss"。 */
  dateFormat?: string;
  /** 仅 fieldType === "reference" 有效。目标表名：app_user 或 ent_xxx。建表后不可更换。 */
  referenceTable?: string;
  /** 仅 fieldType === "reference" 且目标为 sheet 时有意义；缓存目标 sheet.id 以便 UI 反查。 */
  referenceSheetId?: RecordIdString;
  /** 仅 fieldType === "reference" 有效。允许多选；默认为 false。 */
  referenceMultiple?: boolean;
  /** 仅 fieldType === "reference" 有效。展示用字段 key；缺省回退到 name → display_name → email → id。 */
  referenceDisplayKey?: string;
};

/** 单个筛选条件。op 决定 value 是否使用、以及如何使用。 */
export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type FilterClause = {
  key: string;
  op: FilterOp;
  /** 对 in：数组；对 contains/eq/...：标量；对 is_null/is_not_null：忽略 */
  value?: unknown;
};

export type SortClause = {
  key: string;
  direction: "asc" | "desc";
};

/** Sheet 视图的查询参数。所有过滤/排序在数据库执行；隐藏与分组在前端展示层。 */
export type ViewParams = {
  filters?: FilterClause[];
  /** 多条件 AND/OR；默认 AND */
  filterMode?: "and" | "or";
  sorts?: SortClause[];
  hiddenFields?: string[];
  groupBy?: string | null;
};

export type GridRow = {
  id: RecordIdString;
  values: Record<string, unknown>;
};
