import type {
  DashboardBuilderMetricOp,
  DashboardBuilderSpec,
  DashboardViewType,
  GridColumnDef,
} from "@surreal-ck/shared/rpc.types";
import type { DashboardWidget } from "../../../lib/dashboard-data";
import { metricLabel, validateDashboardWidgetSpec } from "../../../lib/dashboard-query";

/** builder 支持的图表类型。table 契约只能由 raw SQL 产生（V1 排除项），故不在列。 */
export type BuilderChartType = Exclude<DashboardViewType, "table">;

export type BuilderTimeBucket = "" | "day" | "week" | "month" | "year";

/** builder 表单的可序列化草稿；组件用 $state 持有，转换/校验全在本模块纯函数里。 */
export type BuilderDraft = {
  title: string;
  chartType: BuilderChartType;
  baseTable: string;
  metricOp: DashboardBuilderMetricOp;
  metricField: string;
  dimensionField: string;
  timeBucket: BuilderTimeBucket;
  filters: BuilderFilterDraft[];
  limit: number;
};

export type BuilderFilterDraft = {
  field: string;
  op: NonNullable<DashboardBuilderSpec["filters"]>[number]["op"];
  value: string;
};

const TIME_SERIES_TYPES: ReadonlySet<BuilderChartType> = new Set(["line", "area"]);

/** 草稿 → shared BuilderSpec（与 D3-02 编译器、AI 草稿同口径）。 */
export function specFromDraft(draft: BuilderDraft): DashboardBuilderSpec {
  const filters = cleanFilters(draft.filters);
  const bucket = TIME_SERIES_TYPES.has(draft.chartType) && draft.timeBucket
    ? draft.timeBucket
    : undefined;
  return {
    sourceTables: [draft.baseTable],
    baseTable: draft.baseTable,
    metric: draft.metricOp === "count"
      ? { op: "count" }
      : { op: draft.metricOp, field: draft.metricField },
    ...(draft.chartType === "kpi"
      ? {}
      : { dimensions: [{ field: draft.dimensionField, ...(bucket ? { bucket } : {}) }] }),
    ...(filters.length ? { filters } : {}),
    limit: draft.limit,
  };
}

/** 新建 widget 时的表单初值。 */
export function blankBuilderDraft(baseTable: string): BuilderDraft {
  return {
    title: "",
    chartType: "bar",
    baseTable,
    metricOp: "count",
    metricField: "",
    dimensionField: "",
    timeBucket: "",
    filters: [],
    limit: 12,
  };
}

export type BuilderFieldOptions = {
  /** sum/avg/min/max 可用的数值字段。 */
  numericFields: GridColumnDef[];
  /** 分组维度可用字段：排除 reference / json / unknown 与 id。 */
  dimensionFields: GridColumnDef[];
  /** 时间桶可用的日期字段。 */
  dateFields: GridColumnDef[];
  /** count_distinct 与筛选可用的全部字段。 */
  allFields: GridColumnDef[];
};

/** 从 sheet 列定义（editorStore sheets）派生 builder 各下拉框的候选字段。 */
export function builderFieldOptions(columns: GridColumnDef[]): BuilderFieldOptions {
  return {
    numericFields: columns.filter((col) => col.fieldType === "number" || col.fieldType === "currency"),
    dimensionFields: columns.filter(
      (col) =>
        col.key !== "id"
        && col.fieldType !== "reference"
        && col.fieldType !== "json"
        && col.fieldType !== "unknown",
    ),
    dateFields: columns.filter((col) => col.fieldType === "date"),
    allFields: columns,
  };
}

export type WidgetFromDraftContext = {
  /** 页内既有 widgets；新建时据此计算流式布局位置。 */
  widgets: DashboardWidget[];
  /** 编辑模式传原 widget：保留其 id 与 grid，配置取草稿。 */
  existing?: DashboardWidget;
  /** 数据表的展示名；自动标题用，缺省回退表名。 */
  tableLabel?: string;
};

/** 页内唯一的 widget id；手工 builder 与 AI 草稿落成（D3-05）共用。 */
export function newWidgetId(): string {
  return `widget_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 草稿落成与 `dashboard_page.widgets[]`（D3-01 DashboardWidget）同口径的 widget。 */
export function widgetFromDraft(draft: BuilderDraft, ctx: WidgetFromDraftContext): DashboardWidget {
  return {
    id: ctx.existing?.id ?? newWidgetId(),
    title: draft.title.trim() || autoTitle(draft, ctx.tableLabel),
    viewType: draft.chartType,
    spec: specFromDraft(draft),
    grid: ctx.existing?.grid ?? nextGridPlacement(ctx.widgets.length, draft.chartType),
  };
}

/** 编辑既有 widget（无论 AI 还是手工产出）时回填 builder 表单。 */
export function draftFromWidget(widget: DashboardWidget): BuilderDraft {
  const dimension = widget.spec.dimensions?.[0];
  return {
    title: widget.title,
    chartType: widget.viewType === "table" ? "bar" : widget.viewType,
    baseTable: widget.spec.baseTable,
    metricOp: widget.spec.metric.op,
    metricField: widget.spec.metric.field ?? "",
    dimensionField: dimension?.field ?? "",
    timeBucket: dimension?.bucket ?? "",
    filters: (widget.spec.filters ?? []).map((filter) => ({
      field: filter.field,
      op: filter.op,
      value: filterValueToInput(filter.value),
    })),
    limit: widget.spec.limit ?? 12,
  };
}

/** 两列流式布局：与 legacy 一致，kpi 高度 1，其余 2。AI 草稿落位（D3-05）共用。 */
export function nextGridPlacement(index: number, chartType: DashboardViewType) {
  return {
    x: (index % 2) * 6,
    y: Math.floor(index / 2) * 2,
    w: 6,
    h: chartType === "kpi" ? 1 : 2,
  };
}

function autoTitle(draft: BuilderDraft, tableLabel?: string): string {
  const pieces = [tableLabel ?? draft.baseTable];
  if (draft.chartType !== "kpi" && draft.dimensionField) pieces.push(draft.dimensionField);
  pieces.push(metricLabel(draft.metricOp, draft.metricField || undefined));
  return pieces.join(" ");
}

function filterValueToInput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

/**
 * 校验草稿；非法时返回中文错误（builder 显示并禁止保存），合法返回 null。
 * 标识符安全等底线规则委托 D3-02 `validateDashboardWidgetSpec`，与执行路径同一份。
 */
export function validateBuilderDraft(draft: BuilderDraft): string | null {
  if (!draft.baseTable) return "请选择数据表";
  if (draft.metricOp !== "count" && !draft.metricField) return "当前统计方式需要选择字段";
  if (draft.chartType !== "kpi" && !draft.dimensionField) return "请选择分组字段";
  try {
    validateDashboardWidgetSpec(specFromDraft(draft));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** 丢弃没填完整的筛选行；数字串转 number，in 操作按逗号拆数组，空值操作不带 value。 */
function cleanFilters(
  filters: BuilderFilterDraft[],
): NonNullable<DashboardBuilderSpec["filters"]> {
  const cleaned: NonNullable<DashboardBuilderSpec["filters"]> = [];
  for (const filter of filters) {
    if (!filter.field) continue;
    if (filter.op === "is_null" || filter.op === "is_not_null") {
      cleaned.push({ field: filter.field, op: filter.op });
      continue;
    }
    const raw = filter.value.trim();
    if (!raw) continue;
    if (filter.op === "in") {
      cleaned.push({
        field: filter.field,
        op: "in",
        value: raw.split(",").map((piece) => coerceFilterValue(piece.trim())),
      });
      continue;
    }
    cleaned.push({ field: filter.field, op: filter.op, value: coerceFilterValue(raw) });
  }
  return cleaned;
}

function coerceFilterValue(value: string): string | number {
  if (value && Number.isFinite(Number(value))) return Number(value);
  return value;
}
