import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";

export const DASHBOARD_EMPTY_TEXT = "暂无数据";
export const DASHBOARD_PLACEHOLDER = "—";

export type DashboardWidgetModelInput = {
  title: string;
  displaySpec?: Record<string, unknown>;
};

export type KpiWidgetModel = {
  label: string;
  value: string;
  unit?: string;
};

export type CategoryChartRow = {
  key: string;
  label: string;
  value: number;
};

export type CategoryChartModel = {
  rows: CategoryChartRow[];
  emptyText: string;
};

export type PieChartRow = CategoryChartRow & {
  share: number;
  shareLabel: string;
};

export type PieChartModel = {
  rows: PieChartRow[];
  emptyText: string;
};

export type TimeSeriesChartRow = {
  x: string;
  y: number;
  series?: string;
};

export type TimeSeriesChartModel = {
  rows: TimeSeriesChartRow[];
  emptyText: string;
};

export type TableWidgetModel = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<{ cells: string[] }>;
  emptyText: string;
};

export function toKpiWidgetModel(
  result: DashboardNormalizedResult | undefined,
  input: DashboardWidgetModelInput,
): KpiWidgetModel {
  if (!isSingleValueResult(result)) {
    return { label: input.title, value: DASHBOARD_PLACEHOLDER };
  }
  return {
    label: stringSetting(input.displaySpec, "metricLabel") ?? result.label ?? input.title,
    value: formatCellValue(result.value) || DASHBOARD_PLACEHOLDER,
    ...(result.unit ? { unit: result.unit } : {}),
  };
}

export function toCategoryChartModel(
  result: DashboardNormalizedResult | undefined,
): CategoryChartModel {
  if (!isCategoryBreakdownResult(result)) return { rows: [], emptyText: DASHBOARD_EMPTY_TEXT };
  return {
    rows: result.rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: toFiniteNumber(row.value),
    })),
    emptyText: DASHBOARD_EMPTY_TEXT,
  };
}

export function toTableWidgetModel(
  result: DashboardNormalizedResult | undefined,
): TableWidgetModel {
  if (!isTableRowsResult(result)) return { columns: [], rows: [], emptyText: DASHBOARD_EMPTY_TEXT };
  return {
    columns: result.columns,
    rows: result.rows.map((row) => ({
      cells: result.columns.map((column) => formatCellValue(row[column.key])),
    })),
    emptyText: DASHBOARD_EMPTY_TEXT,
  };
}

export function toTimeSeriesChartModel(
  result: DashboardNormalizedResult | undefined,
): TimeSeriesChartModel {
  if (!isTimeSeriesResult(result)) return { rows: [], emptyText: DASHBOARD_EMPTY_TEXT };
  return {
    rows: result.rows.map((row) => ({
      x: row.x,
      y: toFiniteNumber(row.y),
      ...(row.series ? { series: row.series } : {}),
    })),
    emptyText: DASHBOARD_EMPTY_TEXT,
  };
}

export function toPieChartModel(
  result: DashboardNormalizedResult | undefined,
): PieChartModel {
  const rows = toCategoryChartModel(result).rows;
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return {
    rows: rows.map((row) => {
      const share = total > 0 ? row.value / total : 0;
      return {
        ...row,
        share,
        shareLabel: formatPercent(share),
      };
    }),
    emptyText: DASHBOARD_EMPTY_TEXT,
  };
}

function isSingleValueResult(
  result: DashboardNormalizedResult | undefined,
): result is Extract<DashboardNormalizedResult, { value: unknown }> {
  return !!result && "value" in result;
}

function isCategoryBreakdownResult(
  result: DashboardNormalizedResult | undefined,
): result is Extract<DashboardNormalizedResult, { rows: Array<{ value: number }> }> {
  if (!result || !("rows" in result) || !Array.isArray(result.rows)) return false;
  const [first] = result.rows;
  return !first || "value" in first;
}

function isTimeSeriesResult(
  result: DashboardNormalizedResult | undefined,
): result is Extract<DashboardNormalizedResult, { rows: Array<{ x: string; y: number }> }> {
  if (!result || !("rows" in result) || !Array.isArray(result.rows)) return false;
  const [first] = result.rows;
  return !first || ("x" in first && "y" in first);
}

function isTableRowsResult(
  result: DashboardNormalizedResult | undefined,
): result is Extract<DashboardNormalizedResult, { columns: Array<{ key: string; label: string }> }> {
  return !!result && "columns" in result && Array.isArray(result.columns) && Array.isArray(result.rows);
}

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function stringSetting(settings: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = settings?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
