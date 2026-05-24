import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { ROUTER_RUNTIME_KEY } from "../workflows/router-workflow";

function makeFakeSession(results: unknown[]) {
  const calls: { sql: string; vars?: Record<string, unknown> }[] = [];
  let cursor = 0;
  return {
    calls,
    async query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return results[cursor++];
    },
  };
}

function ctxWithSession(session: unknown): { requestContext: RequestContext } {
  const requestContext = new RequestContext();
  requestContext.set(ROUTER_RUNTIME_KEY, { surrealSession: session });
  return { requestContext };
}

describe("dashboard tools — 走调用者 session", () => {
  test("inspectSchema 用 session 读 sheet 的 table_name / column_defs，产出 schemaSummary", async () => {
    // 单条 SELECT sheet → [[row, ...]]
    const session = makeFakeSession([[[
      {
        id: "sheet:claims",
        label: "债权台账",
        table_name: "ent_claim",
        column_defs: [
          { key: "name", label: "名称", fieldType: "text" },
          { key: "amount", label: "金额", fieldType: "number" },
        ],
      },
    ]]]);
    const { inspectSchemaTool } = await import("./dashboard-tools");
    const execute = inspectSchemaTool.execute as unknown as (
      input: { tables?: string[] },
      ctx: { requestContext: RequestContext },
    ) => Promise<{
      tables: { table: string; label: string; fields: { key: string }[] }[];
      schemaSummary: { tables: string[]; fieldsByTable: Record<string, string[]> };
    }>;

    const result = await execute({}, ctxWithSession(session));

    expect(session.calls[0].sql).toMatch(/sheet/i);
    expect(result.tables[0].table).toBe("ent_claim");
    expect(result.schemaSummary.tables).toContain("ent_claim");
    expect(result.schemaSummary.fieldsByTable.ent_claim).toEqual(["name", "amount"]);
  });

  test("generateDashboardDraft 不带 preview 时是纯草稿构造（不碰 session/DB）", async () => {
    const { generateDashboardDraftTool } = await import("./dashboard-tools");
    const execute = generateDashboardDraftTool.execute as unknown as (input: {
      description: string;
      workspaceId: string;
      schemas: { table: string; label?: string; fields: { key: string; label: string; fieldType: string }[] }[];
    }) => Promise<{ intent: { type: string; draft: { queryMode: string } } }>;

    const result = await execute({
      description: "按月统计债权金额",
      workspaceId: "workspace:demo",
      schemas: [{
        table: "ent_claim",
        label: "债权台账",
        fields: [
          { key: "amount", label: "金额", fieldType: "number" },
          { key: "created_at", label: "创建", fieldType: "date" },
        ],
      }],
    });
    expect(result.intent.type).toBe("dashboard-draft");
    expect(result.intent.draft.queryMode).toBe("builder");
  });
});
