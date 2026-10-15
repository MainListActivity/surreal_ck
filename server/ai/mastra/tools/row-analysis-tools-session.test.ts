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

describe("proposeRecordWrite 提案字段名归一化（session 读 column_defs）", () => {
  test("label 归一到存储 key、未知字段丢弃；无 session 时保持透传", async () => {
    // QA 报障场景：提案 field=「状态」label，存储键是 field_2。
    const session = makeFakeSession([
      [[{ column_defs: [
        { key: "field_1", label: "标题", field_type: "text" },
        { key: "field_2", label: "状态", field_type: "single_select" },
      ] }]],
    ]);
    const { proposeRecordWriteTool } = await import("./row-analysis-tools");
    const execute = proposeRecordWriteTool.execute as unknown as (
      input: {
        operation: "create" | "update";
        sheetId: string;
        recordId?: string;
        proposals: Array<{ field: string; currentValue: unknown; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }>;
      },
      ctx?: { requestContext: RequestContext },
    ) => Promise<{ intent: { proposals: Array<{ field: string }> } }>;

    const result = await execute({
      operation: "update",
      sheetId: "sheet:members",
      recordId: "ent_members:m1",
      proposals: [
        { field: "状态", currentValue: "在职", suggestedValue: "离职", basis: "成员表更新", confidence: "high" },
        { field: "field_1", currentValue: "甲", suggestedValue: "乙", basis: "key 原样保留", confidence: "medium" },
        { field: "幽灵字段", currentValue: null, suggestedValue: "x", basis: "未知字段被丢弃", confidence: "low" },
      ],
    }, ctxWithSession(session));

    expect(result.intent.proposals.map((p) => p.field)).toEqual(["field_2", "field_1"]);

    // 无 session：行为不变，原样透传。
    const passthrough = await execute({
      operation: "create",
      sheetId: "sheet:members",
      proposals: [{ field: "状态", currentValue: null, suggestedValue: "在职", basis: "b", confidence: "high" }],
    });
    expect(passthrough.intent.proposals.map((p) => p.field)).toEqual(["状态"]);
  });
});

describe("findRecords 按字段值定位记录（def-write-intent-misroute）", () => {
  test("唯一命中返回记录 id 与字段值；查询按归一后的存储 key 过滤", async () => {
    const session = makeFakeSession([
      [[{ id: "sheet:items", table_name: "ent_items", column_defs: [
        { key: "field_1", label: "事项", field_type: "text" },
        { key: "field_2", label: "状态", field_type: "single_select" },
      ] }]],
      [[{ id: "ent_items:a1", field_1: "FV06-ee1-admin-1015-1950-2", field_2: "进行中" }]],
    ]);
    const { findRecordsTool } = await import("./row-analysis-tools");
    const execute = findRecordsTool.execute as unknown as (
      input: { sheetId: string; field: string; value: string; limit?: number },
      ctx?: { requestContext: RequestContext },
    ) => Promise<{ matches: { id: string; values: Record<string, unknown> }[] }>;

    const result = await execute(
      { sheetId: "sheet:items", field: "事项", value: "FV06-ee1-admin-1015-1950-2" },
      ctxWithSession(session),
    );

    expect(session.calls).toHaveLength(2);
    // label「事项」归一到存储 key field_1 后才进查询
    expect(session.calls[1]!.sql).toContain("field_1");
    expect(session.calls[1]!.vars).toMatchObject({ table: "ent_items" });
    expect(result.matches).toEqual([
      { id: "ent_items:a1", values: { id: "ent_items:a1", field_1: "FV06-ee1-admin-1015-1950-2", field_2: "进行中" } },
    ]);
    // 返回纯数据、无 intent——不触发 executor 的 await-write-confirm 挂起
    expect((result as { intent?: unknown }).intent).toBeUndefined();
  });

  test("字段 key/label 都查不到列时返回空匹配，不发起第二条查询", async () => {
    const session = makeFakeSession([
      [[{ id: "sheet:items", table_name: "ent_items", column_defs: [
        { key: "field_1", label: "事项", field_type: "text" },
      ] }]],
    ]);
    const { findRecordsTool } = await import("./row-analysis-tools");
    const execute = findRecordsTool.execute as unknown as (
      input: { sheetId: string; field: string; value: string },
      ctx?: { requestContext: RequestContext },
    ) => Promise<{ matches: unknown[] }>;

    const result = await execute(
      { sheetId: "sheet:items", field: "幽灵字段", value: "x" },
      ctxWithSession(session),
    );
    expect(result.matches).toEqual([]);
    expect(session.calls).toHaveLength(1);
  });
});
