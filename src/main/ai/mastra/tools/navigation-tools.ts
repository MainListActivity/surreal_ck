import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getLocalDb } from "../../../db/index";
import { getCurrentUserRecordId } from "../../../services/context";
import { listWorkbooks } from "../../../services/workbooks";
import { listDashboardPages } from "../../../services/dashboards";

// ─── 共享：获取当前用户的默认 workspace id ─────────────────────────────────────

async function getDefaultWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserRecordId();
  const db = getLocalDb();
  const rows = await db.query<[{ id: unknown }[]]>(
    `SELECT id FROM workspace WHERE owner = $userId LIMIT 1`,
    { userId },
  );
  const row = rows[0]?.[0];
  return row ? String(row.id) : null;
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
  execute: async ({ query }) => {
    const workspaceId = await getDefaultWorkspaceId();
    if (!workspaceId) {
      return { intent: { type: "ambiguous" as const, candidates: [] } };
    }

    const { workbooks } = await listWorkbooks({ workspaceId, search: query });

    if (workbooks.length === 1) {
      return {
        intent: {
          type: "open-workbook" as const,
          workbookId: workbooks[0].id,
          label: workbooks[0].name,
        },
      };
    }

    return {
      intent: {
        type: "ambiguous" as const,
        candidates: workbooks.map((wb) => ({ label: wb.name, id: wb.id })),
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
  execute: async ({ query }) => {
    const workspaceId = await getDefaultWorkspaceId();
    if (!workspaceId) {
      return { intent: { type: "ambiguous" as const, candidates: [] } };
    }

    const { pages } = await listDashboardPages({ workspaceId });
    const lowerQuery = query.trim().toLowerCase();
    const matched = lowerQuery
      ? pages.filter((p) => p.title.toLowerCase().includes(lowerQuery))
      : pages;

    if (matched.length === 1) {
      return {
        intent: {
          type: "open-dashboard" as const,
          dashboardId: matched[0].id,
          label: matched[0].title,
        },
      };
    }

    return {
      intent: {
        type: "ambiguous" as const,
        candidates: matched.map((p) => ({ label: p.title, id: p.id })),
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
  execute: async ({ sheetId, workbookId, query, fieldKey }) => {
    const db = getLocalDb();

    const sheetRows = await db.query<[{ id: unknown; table_name: string; column_defs: unknown[] }[]]>(
      `SELECT id, table_name, column_defs FROM sheet WHERE id = $sheetId LIMIT 1`,
      { sheetId: { tb: "sheet", id: sheetId.replace(/^sheet:/, "") } },
    );
    const sheetRow = sheetRows[0]?.[0];
    if (!sheetRow) {
      return { intent: { type: "ambiguous" as const, candidates: [] } };
    }

    const tableName = sheetRow.table_name;
    const lowerQuery = query.trim().toLowerCase();

    const filterClause = fieldKey
      ? `string::contains(string::lowercase(string(${ fieldKey })), $q)`
      : `string::contains(string::lowercase(string(name ?? display_name ?? id)), $q)`;

    const rows = await db.query<[{ id: unknown; name?: string; display_name?: string }[]]>(
      `SELECT id, name, display_name FROM ${tableName} WHERE ${filterClause} LIMIT 20`,
      { q: lowerQuery },
    );

    const matched = rows[0] ?? [];
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
