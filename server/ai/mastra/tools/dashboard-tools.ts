import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getSurrealSession, type ToolRequestContext } from "./tool-session";
import { createDashboardDraftIntent, type DashboardDraftSchema as DraftSchema } from "./dashboard-draft";

/** SurrealDB SDK query() 返回「每条语句结果」数组；取第一条语句行集。 */
function firstStatementRows<T>(queryResult: unknown): T[] {
  if (!Array.isArray(queryResult)) return [];
  const first = queryResult[0];
  return Array.isArray(first) ? (first as T[]) : [];
}

/** dashboard 预览要跑 builder→SurrealQL 的链路，依赖尚未定稿的查询执行器；定稿前明确抛 TODO，不退回 root/legacy。 */
const DASHBOARD_PREVIEW_TODO =
  "TODO: dashboard 预览（builder→SurrealQL 执行）在 web pivot 后尚未定稿，includePreview 暂不可用（不退回 root/legacy 连接）";

const TableSchemaFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  nullable: z.boolean().optional(),
  referenceTable: z.string().optional(),
});

const InspectSchemaOutputSchema = z.object({
  tables: z.array(z.object({
    table: z.string(),
    label: z.string(),
    fields: z.array(TableSchemaFieldSchema),
  })),
  schemaSummary: z.object({
    tables: z.array(z.string()),
    fieldsByTable: z.record(z.string(), z.array(z.string())),
  }),
});

export const inspectSchemaTool = createTool({
  id: "inspectSchema",
  description: "读取当前工作空间可用于仪表盘生成的业务表和字段定义。生成草稿前必须先调用它理解表结构。",
  inputSchema: z.object({
    tables: z.array(z.string()).optional().describe("可选：只检查指定表名；为空则读取可用业务表。"),
  }),
  outputSchema: InspectSchemaOutputSchema,
  execute: async ({ tables }, ctx) => {
    const db = getSurrealSession(ctx as ToolRequestContext);
    // 每个 sheet 背后是一张真实业务数据表：table_name 是表名，column_defs 是列定义。
    const result = await db.query(
      `SELECT label, table_name, column_defs FROM sheet ORDER BY label`,
    );
    const sheets = firstStatementRows<{
      label: string;
      table_name: string;
      column_defs: Array<z.infer<typeof TableSchemaFieldSchema>>;
    }>(result);

    const filtered = tables?.length
      ? sheets.filter((sheet) => tables.includes(sheet.table_name))
      : sheets;

    const inspected = filtered.map((sheet) => ({
      table: sheet.table_name,
      label: sheet.label,
      fields: sheet.column_defs ?? [],
    }));

    return {
      tables: inspected,
      schemaSummary: {
        tables: inspected.map((item) => item.table),
        fieldsByTable: Object.fromEntries(
          inspected.map((item) => [item.table, item.fields.map((field) => field.key)]),
        ),
      },
    };
  },
});

const DashboardBuilderSpecSchema = z.object({
  sourceTables: z.array(z.string()),
  baseTable: z.string(),
  metric: z.object({
    op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
    field: z.string().optional(),
  }),
  dimensions: z.array(z.object({
    field: z.string(),
    bucket: z.enum(["day", "week", "month", "year"]).optional(),
  })).optional(),
  filters: z.array(z.object({
    field: z.string(),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "is_not_null"]),
    value: z.unknown().optional(),
  })).optional(),
  sort: z.object({
    field: z.string(),
    direction: z.enum(["asc", "desc"]),
  }).optional(),
  limit: z.number().optional(),
});

const DashboardDraftOutputSchema = z.object({
  intent: z.object({
    type: z.literal("dashboard-draft"),
    title: z.string(),
    description: z.string(),
    widgetSpec: DashboardBuilderSpecSchema,
    draft: z.object({
      workspaceId: z.string(),
      workbookId: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      queryMode: z.literal("builder"),
      viewType: z.enum(["kpi", "table", "bar", "line", "pie", "area"]),
      resultContract: z.enum(["single_value", "category_breakdown", "time_series", "table_rows"]),
      builderSpec: DashboardBuilderSpecSchema,
      status: z.enum(["draft", "active", "invalid"]).optional(),
    }),
    explanation: z.string(),
    preview: z.unknown().optional(),
  }),
});

export const generateDashboardDraftTool = createTool({
  id: "generateDashboardDraft",
  description: "根据用户的统计描述和已检查 schema 生成 dashboard-draft 草稿意图。优先产出 builder-style widgetSpec；仅在 builder 无法表达时才交由 SQL 草稿链路。",
  inputSchema: z.object({
    description: z.string().describe("用户对仪表盘/图表的自然语言需求"),
    workspaceId: z.string().describe("当前 workspace record id"),
    workbookId: z.string().optional().describe("当前 workbook record id"),
    schemas: z.array(z.object({
      table: z.string(),
      label: z.string().optional(),
      fields: z.array(TableSchemaFieldSchema),
    })).describe("来自 inspectSchema 的表和字段定义"),
    includePreview: z.boolean().optional().describe("是否立即走 dashboard-query 预览验证"),
  }),
  outputSchema: DashboardDraftOutputSchema,
  execute: async ({ description, workspaceId, workbookId, schemas, includePreview }) => {
    if (includePreview) {
      throw new Error(DASHBOARD_PREVIEW_TODO);
    }

    const intent = createDashboardDraftIntent({
      description,
      workspaceId,
      workbookId,
      schemas: schemas as DraftSchema[],
    });

    return {
      intent: {
        ...intent,
        draft: {
          ...intent.draft,
          queryMode: "builder" as const,
          builderSpec: intent.widgetSpec,
        },
      },
    };
  },
});

export const DASHBOARD_TOOLS = {
  inspectSchema: inspectSchemaTool,
  generateDashboardDraft: generateDashboardDraftTool,
} as const;
