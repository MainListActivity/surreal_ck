import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type {
  DashboardViewDraftDTO,
  PreviewDashboardViewResponse,
  ReferenceTargetOption,
} from "@surreal-ck/shared";

const LEGACY_DASHBOARD_DRAFT_MODULE: string = "../../../legacy/services/dashboard-draft";
const LEGACY_DASHBOARD_MASTRA_MODULE: string = "../../../legacy/services/dashboard-mastra";
const LEGACY_TABLE_SCHEMA_MODULE: string = "../../../legacy/services/table-schema";

const TableSchemaFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  nullable: z.boolean().optional(),
  referenceTable: z.string().optional(),
});

type DashboardDraftSchema = {
  table: string;
  label?: string;
  fields: Array<z.infer<typeof TableSchemaFieldSchema>>;
};

type DashboardBuilderSpec = {
  sourceTables: string[];
  baseTable: string;
  metric: {
    op: "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
    field?: string;
  };
  dimensions?: Array<{
    field: string;
    bucket?: "day" | "week" | "month" | "year";
  }>;
  filters?: Array<{
    field: string;
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "is_null" | "is_not_null";
    value?: unknown;
  }>;
  sort?: {
    field: string;
    direction: "asc" | "desc";
  };
  limit?: number;
};

type DashboardDraftIntent = {
  type: "dashboard-draft";
  title: string;
  description: string;
  widgetSpec: DashboardBuilderSpec;
  draft: DashboardViewDraftDTO;
  explanation: string;
  preview?: unknown;
};

async function listLegacyDashboardGenerationTargets(): Promise<ReferenceTargetOption[]> {
  const { listDashboardGenerationTargets } = await import(LEGACY_DASHBOARD_MASTRA_MODULE) as {
    listDashboardGenerationTargets(): Promise<ReferenceTargetOption[]>;
  };
  return listDashboardGenerationTargets();
}

async function previewLegacyGeneratedDashboardView(
  draft: DashboardViewDraftDTO,
): Promise<PreviewDashboardViewResponse> {
  const { previewGeneratedDashboardView } = await import(LEGACY_DASHBOARD_MASTRA_MODULE) as {
    previewGeneratedDashboardView(input: DashboardViewDraftDTO): Promise<PreviewDashboardViewResponse>;
  };
  return previewGeneratedDashboardView(draft);
}

async function getLegacyTableSchema(table: string): Promise<{
  fields: Array<z.infer<typeof TableSchemaFieldSchema>>;
}> {
  const { getTableSchema } = await import(LEGACY_TABLE_SCHEMA_MODULE) as {
    getTableSchema(input: { table: string }): Promise<{ fields: Array<z.infer<typeof TableSchemaFieldSchema>> }>;
  };
  return getTableSchema({ table });
}

async function createLegacyDashboardDraftIntent(input: {
  description: string;
  workspaceId: string;
  workbookId?: string;
  schemas: DashboardDraftSchema[];
}): Promise<DashboardDraftIntent> {
  const { createDashboardDraftIntent } = await import(LEGACY_DASHBOARD_DRAFT_MODULE) as {
    createDashboardDraftIntent(args: {
      description: string;
      workspaceId: string;
      workbookId?: string;
      schemas: DashboardDraftSchema[];
    }): DashboardDraftIntent;
  };
  return createDashboardDraftIntent(input);
}

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
  execute: async ({ tables }) => {
    const targets = await listLegacyDashboardGenerationTargets();
    const targetTables = tables?.length
      ? targets.filter((target) => tables.includes(target.table))
      : targets;

    const inspected = await Promise.all(targetTables.map(async (target) => {
      const schema = await getLegacyTableSchema(target.table);
      return {
        table: target.table,
        label: target.label,
        fields: schema.fields,
      };
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
    const intent = await createLegacyDashboardDraftIntent({
      description,
      workspaceId,
      workbookId,
      schemas: schemas as DashboardDraftSchema[],
    });

    if (includePreview) {
      intent.preview = await previewLegacyGeneratedDashboardView(intent.draft);
    }

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
