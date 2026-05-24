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

describe("claim-analysis tools — 走调用者 session", () => {
  test("analyzeClaimRow 传入 values+fields 时纯构造提案（不碰 session/DB）", async () => {
    const { analyzeClaimRowTool } = await import("./claim-analysis-tools");
    const execute = analyzeClaimRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: { key: string; label: string; fieldType: string }[];
      suggestions: { field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }[];
    }) => Promise<{ intent: { type: string; proposals: { field: string }[] } }>;

    const result = await execute({
      sheetId: "sheet:claims",
      recordId: "ent_claim:abc",
      values: { name: "张三", amount: 100 },
      fields: [
        { key: "name", label: "名称", fieldType: "text" },
        { key: "amount", label: "金额", fieldType: "number" },
      ],
      suggestions: [
        { field: "amount", suggestedValue: 200, basis: "据证据", confidence: "high" },
      ],
    });
    expect(result.intent.type).toBe("row-patch-proposal");
    expect(result.intent.proposals).toHaveLength(1);
    expect(result.intent.proposals[0].field).toBe("amount");
  });

  test("analyzeClaimRow 缺 values/fields 时用 session 读当前行和列定义", async () => {
    // 第一条 query：读 sheet 拿 table_name + column_defs；第二条：读 record
    const session = makeFakeSession([
      [[{ id: "sheet:claims", table_name: "ent_claim", column_defs: [
        { key: "name", label: "名称", fieldType: "text" },
        { key: "amount", label: "金额", fieldType: "number" },
      ] }]],
      [[{ id: "ent_claim:abc", name: "张三", amount: 100 }]],
    ]);
    const { analyzeClaimRowTool } = await import("./claim-analysis-tools");
    const execute = analyzeClaimRowTool.execute as unknown as (
      input: {
        workbookId: string;
        sheetId: string;
        recordId: string;
        suggestions: { field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }[];
      },
      ctx: { requestContext: RequestContext },
    ) => Promise<{ intent: { proposals: { field: string; currentValue: unknown }[] } }>;

    const result = await execute({
      workbookId: "workbook:1",
      sheetId: "sheet:claims",
      recordId: "ent_claim:abc",
      suggestions: [{ field: "amount", suggestedValue: 200, basis: "据证据", confidence: "high" }],
    }, ctxWithSession(session));

    expect(session.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.intent.proposals[0].currentValue).toBe(100);
  });
});
