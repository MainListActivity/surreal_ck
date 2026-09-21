import type { ISODateTimeString, RecordIdString } from "./transport";

// ─── Dashboard DTOs ──────────────────────────────────────────────────────────

export type DashboardQueryMode = "preset" | "builder" | "sql";
export type DashboardViewType = "kpi" | "table" | "bar" | "line" | "pie" | "area";
export type DashboardResultContract =
  | "single_value"
  | "category_breakdown"
  | "time_series"
  | "table_rows";
export type DashboardViewStatus = "draft" | "active" | "invalid";
export type DashboardCacheStatus = "ok" | "error" | "stale" | "running";

export type DashboardBuilderMetricOp =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max";

export type DashboardBuilderFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "in"
  | "is_null"
  | "is_not_null";

export type DashboardBuilderSpec = {
  sourceTables: string[];
  baseTable: string;
  metric: {
    op: DashboardBuilderMetricOp;
    field?: string;
  };
  dimensions?: Array<{
    field: string;
    bucket?: "day" | "week" | "month" | "year";
  }>;
  filters?: Array<{
    field: string;
    op: DashboardBuilderFilterOp;
    value?: unknown;
  }>;
  sort?: {
    field: string;
    direction: "asc" | "desc";
  };
  limit?: number;
};

export type DashboardViewSummaryDTO = {
  id: RecordIdString;
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  status: DashboardViewStatus;
  updatedAt?: ISODateTimeString;
  lastRunAt?: ISODateTimeString;
};

export type DashboardViewDTO = DashboardViewSummaryDTO & {
  compiledSql: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  sourceTables: string[];
  dependencies: string[];
  version: number;
  createdBy?: RecordIdString;
};

export type DashboardSingleValueResult = {
  value: number | string | boolean | null;
  label?: string;
  unit?: string;
  delta?: number | null;
};

export type DashboardCategoryBreakdownResult = {
  rows: Array<{ key: string; label: string; value: number }>;
};

export type DashboardTimeSeriesResult = {
  rows: Array<{ x: string; y: number; series?: string }>;
};

export type DashboardTableRowsResult = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
};

export type DashboardNormalizedResult =
  | DashboardSingleValueResult
  | DashboardCategoryBreakdownResult
  | DashboardTimeSeriesResult
  | DashboardTableRowsResult;

export type DashboardCacheDTO = {
  viewId: RecordIdString;
  status: DashboardCacheStatus;
  rowsCount: number;
  durationMs: number;
  executedAt?: ISODateTimeString;
  sqlHash: string;
  result?: DashboardNormalizedResult;
  resultMeta?: Record<string, unknown>;
  errorDetail?: unknown;
};

export type DashboardViewDraftDTO = {
  workspaceId: RecordIdString;
  workbookId?: RecordIdString;
  title: string;
  slug?: string;
  description?: string;
  queryMode: DashboardQueryMode;
  viewType: DashboardViewType;
  resultContract: DashboardResultContract;
  compiledSql?: string;
  builderSpec?: DashboardBuilderSpec;
  displaySpec?: Record<string, unknown>;
  status?: DashboardViewStatus;
};

export type DashboardPreviewResponse = {
  sql: string;
  sourceTables: string[];
  dependencies: string[];
  durationMs: number;
  rowsCount: number;
  result: DashboardNormalizedResult;
  resultMeta: Record<string, unknown>;
  sqlHash: string;
};

export type CreateDashboardViewResponse = {
  view: DashboardViewDTO;
  cache?: DashboardCacheDTO;
};

export type PreviewDashboardViewResponse = DashboardPreviewResponse;
