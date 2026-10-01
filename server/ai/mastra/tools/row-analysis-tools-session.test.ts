import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { setExecutionContext } from "../execution-context";

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
  setExecutionContext(requestContext, { surrealSession: session as never });
  return { requestContext };
}

describe("row-analysis tools — 走调用者 session", () => {
  test("analyzeRow 传入 values+fields 时纯构造提案（不碰 session/DB）", async () => {
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: { key: string; label: string; fieldType: string }[];
      suggestions: { field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }[];
    }) => Promise<{ intent: { type: string; proposals: { field: string }[] } }>;

    const result = await execute({
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
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

  test("analyzeRow 缺 values/fields 时用 session 读当前行和列定义", async () => {
    // 第一条 query：读 sheet 拿 table_name + column_defs；第二条：读 record
    const session = makeFakeSession([
      [[{ id: "sheet:devices", table_name: "ent_devices", column_defs: [
        { key: "name", label: "名称", fieldType: "text" },
        { key: "amount", label: "金额", fieldType: "number" },
      ] }]],
      [[{ id: "ent_devices:abc", name: "冷却泵", amount: 100 }]],
    ]);
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (
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
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
      suggestions: [{ field: "amount", suggestedValue: 200, basis: "据证据", confidence: "high" }],
    }, ctxWithSession(session));

    expect(session.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.intent.proposals[0].currentValue).toBe(100);
  });

  test("fetchRelatedRecords 优先读取当前记录关联资源并返回结构化 citations", async () => {
    const session = makeFakeSession([
      [[{
        resource_id: "resource_item:r1",
        title: "巡检规程文档",
        summary: "规程摘要",
        source_url: "https://example.test/case",
        evidence: [{ order: 0, text: "读数超过阈值时应复核。" }],
      }]],
    ]);
    const { fetchRelatedRecordsTool } = await import("./row-analysis-tools");
    const execute = fetchRelatedRecordsTool.execute as unknown as (
      input: {
        recordId: string;
        values: Record<string, unknown>;
        fields: { key: string; label: string; fieldType: string }[];
      },
      ctx: { requestContext: RequestContext },
    ) => Promise<{
      source: string;
      items: unknown[];
      citations: Array<{ index: number; resourceId: string; title: string; sourceUrl?: string }>;
    }>;

    const result = await execute({
      recordId: "ent_devices:c1",
      values: { vendor: "ent_vendor:a" },
      fields: [{ key: "vendor", label: "供应商", fieldType: "reference" }],
    }, ctxWithSession(session));

    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]!.sql).toContain("FROM $record<-resource_record_link");
    expect(result.source).toBe("record-resources");
    expect(result.citations).toEqual([{
      index: 1,
      resourceId: "resource_item:r1",
      title: "巡检规程文档",
      sourceUrl: "https://example.test/case",
      evidence: [{ order: 0, text: "读数超过阈值时应复核。" }],
    }]);
  });

  test("当前记录无关联资源时回退读取普通 reference 字段", async () => {
    const session = makeFakeSession([
      [[]],
      [[{ id: "ent_vendor:a", name: "甲公司" }]],
    ]);
    const { fetchRelatedRecordsTool } = await import("./row-analysis-tools");
    const execute = fetchRelatedRecordsTool.execute as unknown as (
      input: {
        recordId: string;
        values: Record<string, unknown>;
        fields: { key: string; label: string; fieldType: string }[];
      },
      ctx: { requestContext: RequestContext },
    ) => Promise<{ source: string; items: unknown[]; citations: unknown[] }>;

    const result = await execute({
      recordId: "ent_devices:c1",
      values: { vendor: "ent_vendor:a" },
      fields: [{ key: "vendor", label: "供应商", fieldType: "reference" }],
    }, ctxWithSession(session));

    expect(session.calls).toHaveLength(2);
    expect(session.calls[1]!.sql).toBe("SELECT * FROM $ids");
    expect(result).toEqual({
      source: "related-records",
      items: [{ id: "ent_vendor:a", name: "甲公司" }],
      citations: [],
    });
  });
});
