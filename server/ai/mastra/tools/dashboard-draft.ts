import type {
  DashboardBuilderMetricOp,
  DashboardBuilderSpec,
  DashboardDraftIntent,
  DashboardViewDraftDTO,
  DashboardViewType,
  TableSchemaField,
} from "@surreal-ck/shared";

export type DashboardDraftSchema = {
  table: string;
  label?: string;
  fields: TableSchemaField[];
};

export type CreateDashboardDraftInput = {
  description: string;
  workspaceId: string;
  workbookId?: string;
  schemas: DashboardDraftSchema[];
};

/**
 * 纯启发式：把用户的统计描述 + 已检查 schema 编译成 builder-style dashboard-draft 草稿意图。
 * 无 DB / 无 root 访问；仅文本匹配 + 字段挑选。迁自 legacy/services/dashboard-draft.ts。
 */
export function createDashboardDraftIntent(input: CreateDashboardDraftInput): DashboardDraftIntent {
  const description = input.description.trim();
  if (!description) throw new Error("缺少仪表盘需求描述");
  if (!input.workspaceId) throw new Error("缺少工作区上下文");
  if (input.schemas.length === 0) throw new Error("没有可用的数据表 schema");

  const schema = pickSchema(description, input.schemas);
  const metric = pickMetric(description, schema.fields);
  const dimension = pickDimension(description, schema.fields);
  const bucket = pickBucket(description);
  const viewType: DashboardViewType = dimension?.fieldType === "date" || bucket ? "line" : "bar";

  const widgetSpec: DashboardBuilderSpec = {
    sourceTables: [schema.table],
    baseTable: schema.table,
    metric,
    dimensions: dimension ? [{ field: dimension.key, bucket }] : undefined,
    limit: viewType === "line" ? 24 : 12,
  };

  const title = buildTitle(description, schema, metric, dimension, bucket);
  const draft: DashboardViewDraftDTO = {
    workspaceId: input.workspaceId,
    workbookId: input.workbookId,
    title,
    description,
    queryMode: "builder",
    viewType,
    resultContract: viewType === "line" ? "time_series" : "category_breakdown",
    builderSpec: widgetSpec,
    status: "draft",
  };

  return {
    type: "dashboard-draft",
    title,
    description,
    widgetSpec,
    draft,
    explanation: buildExplanation(schema, metric, dimension, bucket),
  };
}

function pickSchema(description: string, schemas: DashboardDraftSchema[]): DashboardDraftSchema {
  const scored = schemas.map((schema) => ({
    schema,
    score: scoreText(description, schema.label ?? schema.table)
      + schema.fields.reduce((sum, field) => sum + scoreText(description, field.label) + scoreText(description, field.key), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].schema;
}

function pickMetric(
  description: string,
  fields: TableSchemaField[],
): DashboardBuilderSpec["metric"] {
  const numericFields = fields.filter((field) => isNumericField(field));
  if (numericFields.length === 0 || /数量|个数|记录数|计数/.test(description)) {
    return { op: "count" };
  }

  const amountField = pickField(description, numericFields, ["金额", "数额", "合计", "总额", "amount", "price", "total"]);
  const op: DashboardBuilderMetricOp = /平均|均值|avg/i.test(description) ? "avg" : "sum";
  return { op, field: amountField.key };
}

function pickDimension(description: string, fields: TableSchemaField[]): TableSchemaField | null {
  const dateFields = fields.filter((field) => field.fieldType === "date");
  if (/趋势|按月|每月|按日|每天|按年|年度|时间|日期/.test(description) && dateFields.length > 0) {
    return pickField(description, dateFields, ["申报", "提交", "创建", "更新", "日期", "时间", "date", "time", "created"]);
  }

  const categoryFields = fields.filter((field) =>
    !["id", "created_at", "updated_at"].includes(field.key)
    && field.fieldType !== "json"
    && field.fieldType !== "unknown"
  );
  return categoryFields[0] ?? null;
}

function pickBucket(description: string): "day" | "week" | "month" | "year" | undefined {
  if (/按年|年度|每年/.test(description)) return "year";
  if (/按周|每周/.test(description)) return "week";
  if (/按日|每天|每日/.test(description)) return "day";
  if (/按月|每月|月度|趋势/.test(description)) return "month";
  return undefined;
}

function pickField(description: string, fields: TableSchemaField[], preferredTokens: string[]): TableSchemaField {
  const scored = fields.map((field) => ({
    field,
    score: scoreText(description, field.label)
      + scoreText(description, field.key)
      + preferredTokens.reduce((sum, token) => sum + scoreText(`${field.label} ${field.key}`, token), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].field;
}

function isNumericField(field: TableSchemaField): boolean {
  return field.fieldType === "number" || field.fieldType === "currency";
}

function scoreText(haystack: string, needle: string | undefined): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (h.includes(n)) return n.length;
  let score = 0;
  for (const char of n) {
    if (h.includes(char)) score += 1;
  }
  return score;
}

function buildTitle(
  description: string,
  schema: DashboardDraftSchema,
  metric: DashboardBuilderSpec["metric"],
  dimension: TableSchemaField | null,
  bucket?: "day" | "week" | "month" | "year",
): string {
  const metricLabel = metric.field
    ? schema.fields.find((field) => field.key === metric.field)?.label ?? metric.field
    : "记录数";
  if (dimension?.fieldType === "date" || bucket) {
    return `${metricLabel}${bucketLabel(bucket)}趋势`;
  }
  if (/趋势/.test(description)) return `${metricLabel}趋势`;
  const tableLabel = schema.label ?? schema.table;
  return `${tableLabel}${metricLabel}统计`;
}

function buildExplanation(
  schema: DashboardDraftSchema,
  metric: DashboardBuilderSpec["metric"],
  dimension: TableSchemaField | null,
  bucket?: "day" | "week" | "month" | "year",
): string {
  const tableLabel = schema.label ?? schema.table;
  const metricField = metric.field
    ? schema.fields.find((field) => field.key === metric.field)?.label ?? metric.field
    : "记录数";
  const opLabel = metric.op === "sum" ? "求和" : metric.op === "avg" ? "求平均" : "计数";
  if (dimension) {
    return `基于 ${tableLabel}，按${bucketLabel(bucket) || dimension.label}对${metricField}${opLabel}。`;
  }
  return `基于 ${tableLabel}，对${metricField}${opLabel}。`;
}

function bucketLabel(bucket?: "day" | "week" | "month" | "year"): string {
  switch (bucket) {
    case "day": return "日";
    case "week": return "周";
    case "month": return "月";
    case "year": return "年";
    default: return "";
  }
}
