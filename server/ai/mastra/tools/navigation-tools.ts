import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { StringRecordId } from "surrealdb";
import { getSurrealSession, type ToolRequestContext } from "./tool-session";

/** SurrealDB SDK 的 query 返回「每条语句结果」的数组；取第一条语句的行集。 */
function firstStatementRows<T>(queryResult: unknown): T[] {
  if (!Array.isArray(queryResult)) return [];
  const first = queryResult[0];
  return Array.isArray(first) ? (first as T[]) : [];
}

// ─── navigate tool ────────────────────────────────────────────────────────────

const NavigateIntentSchema = z.object({
  intent: z.object({
    type: z.literal("navigate"),
    route: z.string(),
  }),
});

export const navigateTool = createTool({
  id: "navigate",
  description: "跳转到应用的指定功能页面（如首页、设置、模板中心、仪表盘）。route 可选值：home / settings / templates / dashboard / editor",
  inputSchema: z.object({
    route: z.enum(["home", "settings", "templates", "dashboard", "editor"]),
  }),
  outputSchema: NavigateIntentSchema,
  execute: async ({ route }) => ({
    intent: { type: "navigate" as const, route },
  }),
});

// ─── searchWorkbook tool ──────────────────────────────────────────────────────

const AmbiguousIntentSchema = z.object({
  intent: z.object({
    type: z.literal("ambiguous"),
    candidates: z.array(z.object({ label: z.string(), id: z.string() })),
  }),
});

const OpenWorkbookIntentSchema = z.object({
  intent: z.object({
    type: z.literal("open-workbook"),
    workbookId: z.string(),
    label: z.string(),
  }),
});

const SearchWorkbookOutputSchema = z.union([OpenWorkbookIntentSchema, AmbiguousIntentSchema]);

export const searchWorkbookTool = createTool({
  id: "searchWorkbook",
  description: "按名称或业务含义搜索工作簿。找到唯一匹配时返回 open-workbook 意图；找到多个时返回 ambiguous 候选列表；未找到时返回空 ambiguous。",
  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
  }),
  outputSchema: SearchWorkbookOutputSchema,
  execute: async ({ query }, ctx) => {
    const db = getSurrealSession(ctx as ToolRequestContext);
    const q = query.trim().toLowerCase();
    const result = await db.query(
      `SELECT id, name FROM workbook
       WHERE $q = "" OR string::lowercase(name) CONTAINS $q
       ORDER BY name LIMIT 20`,
      { q },
    );
    const workbooks = firstStatementRows<{ id: unknown; name: string }>(result);

    if (workbooks.length === 1) {
      return {
        intent: {
          type: "open-workbook" as const,
          workbookId: String(workbooks[0].id),
          label: workbooks[0].name,
        },
      };
    }

    return {
      intent: {
        type: "ambiguous" as const,
        candidates: workbooks.map((wb) => ({ label: wb.name, id: String(wb.id) })),
      },
    };
  },
});

// ─── searchDashboard tool ─────────────────────────────────────────────────────

const OpenDashboardIntentSchema = z.object({
  intent: z.object({
    type: z.literal("open-dashboard"),
    dashboardId: z.string(),
    label: z.string(),
  }),
});

const SearchDashboardOutputSchema = z.union([OpenDashboardIntentSchema, AmbiguousIntentSchema]);

export const searchDashboardTool = createTool({
  id: "searchDashboard",
  description: "按名称搜索仪表盘。找到唯一匹配时返回 open-dashboard 意图；找到多个时返回 ambiguous 候选列表。",
  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
  }),
  outputSchema: SearchDashboardOutputSchema,
  execute: async ({ query }, ctx) => {
    const db = getSurrealSession(ctx as ToolRequestContext);
    const q = query.trim().toLowerCase();
    const result = await db.query(
      `SELECT id, title FROM dashboard_page
       WHERE $q = "" OR string::lowercase(title) CONTAINS $q
       ORDER BY title LIMIT 20`,
      { q },
    );
    const pages = firstStatementRows<{ id: unknown; title: string }>(result);

    if (pages.length === 1) {
      return {
        intent: {
          type: "open-dashboard" as const,
          dashboardId: String(pages[0].id),
          label: pages[0].title,
        },
      };
    }

    return {
      intent: {
        type: "ambiguous" as const,
        candidates: pages.map((p) => ({ label: p.title, id: String(p.id) })),
      },
    };
  },
});

// ─── searchRecord tool ────────────────────────────────────────────────────────

const OpenRecordIntentSchema = z.object({
  intent: z.object({
    type: z.literal("open-record"),
    workbookId: z.string(),
    sheetId: z.string(),
    recordId: z.string(),
    label: z.string(),
  }),
});

const SearchRecordOutputSchema = z.union([OpenRecordIntentSchema, AmbiguousIntentSchema]);

export const searchRecordTool = createTool({
  id: "searchRecord",
  description: "在指定数据表（sheetId）中按关键字搜索记录。找到唯一匹配时返回 open-record 意图；找到多个时返回 ambiguous 候选列表。",
  inputSchema: z.object({
    sheetId: z.string().describe("目标 sheet 的 record id，格式 'sheet:xxx'"),
    workbookId: z.string().describe("工作簿 record id，格式 'workbook:xxx'"),
    query: z.string().describe("搜索关键词"),
    fieldKey: z.string().optional().describe("要搜索的字段 key；缺省时在所有文本字段中搜索"),
  }),
  outputSchema: SearchRecordOutputSchema,
  execute: async ({ sheetId, workbookId, query, fieldKey }, ctx) => {
    const db = getSurrealSession(ctx as ToolRequestContext);

    const sheetResult = await db.query(
      `SELECT id, table_name, column_defs FROM $sheet LIMIT 1`,
      { sheet: new StringRecordId(sheetId) },
    );
    const sheetRow = firstStatementRows<{ id: unknown; table_name: string; column_defs: unknown[] }>(sheetResult)[0];
    if (!sheetRow) {
      return { intent: { type: "ambiguous" as const, candidates: [] } };
    }

    const tableName = sheetRow.table_name;
    const lowerQuery = query.trim().toLowerCase();

    const filterClause = fieldKey
      ? `string::contains(string::lowercase(string(${ fieldKey })), $q)`
      : `string::contains(string::lowercase(string(name ?? display_name ?? id)), $q)`;

    const recordResult = await db.query(
      `SELECT id, name, display_name FROM type::table($table) WHERE ${filterClause} LIMIT 20`,
      { table: tableName, q: lowerQuery },
    );

    const matched = firstStatementRows<{ id: unknown; name?: string; display_name?: string }>(recordResult);
    const candidates = matched.map((r) => ({
      label: String(r.name ?? r.display_name ?? r.id),
      id: String(r.id),
    }));

    if (candidates.length === 1) {
      return {
        intent: {
          type: "open-record" as const,
          workbookId,
          sheetId,
          recordId: candidates[0].id,
          label: candidates[0].label,
        },
      };
    }

    return {
      intent: { type: "ambiguous" as const, candidates },
    };
  },
});
