import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "@surreal-ck/shared";

const fields: GridColumnDef[] = [
  { key: "device_name", label: "设备名称", fieldType: "text" },
  { key: "reading", label: "读数", fieldType: "currency" },
  { key: "created_at", label: "创建时间", fieldType: "date" },
];

describe("analyzeRow tool", () => {
  test("跨数据表新建建议只形成 record-write-proposal，不需要或使用数据库会话", async () => {
    const { proposeRecordWriteTool } = await import("./row-analysis-tools");
    const execute = proposeRecordWriteTool.execute as unknown as (input: {
      operation: "create";
      sheetId: string;
      proposals: Array<{
        field: string;
        currentValue: unknown;
        suggestedValue: unknown;
        basis: string;
        confidence: "high" | "medium" | "low";
      }>;
    }) => Promise<{ intent: { type: string; operation: string; sheetId: string } }>;

    const result = await execute({
      operation: "create",
      sheetId: "sheet:tasks",
      proposals: [{
        field: "task_name",
        currentValue: null,
        suggestedValue: "补充送货签收单",
        basis: "材料记录标记为缺失",
        confidence: "high",
      }],
    });

    expect(result.intent).toMatchObject({
      type: "record-write-proposal",
      operation: "create",
      sheetId: "sheet:tasks",
    });
  });

  test("提案只包含当前数据表的可编辑字段", async () => {
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: GridColumnDef[];
      suggestions: Array<{
        field: string;
        suggestedValue: unknown;
        basis: string;
        confidence: "high" | "medium" | "low";
      }>;
    }) => Promise<{
      intent: {
        type: "row-patch-proposal";
        recordId: string;
        proposals: Array<{
          field: string;
          currentValue: unknown;
          suggestedValue: unknown;
          basis: string;
          confidence: "high" | "medium" | "low";
        }>;
      };
    }>;

    const result = await execute({
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
      fields,
      values: {
        device_name: "",
        reading: 1000,
        created_at: "2026-05-01T00:00:00.000Z",
      },
      suggestions: [
        { field: "device_name", suggestedValue: "冷却泵", basis: "巡检单抬头", confidence: "high" },
        { field: "created_at", suggestedValue: "2026-05-02T00:00:00.000Z", basis: "系统字段", confidence: "medium" },
        { field: "ghost_field", suggestedValue: "忽略", basis: "不存在", confidence: "low" },
      ],
    });

    expect(result.intent).toMatchObject({
      type: "row-patch-proposal",
      recordId: "ent_devices:abc",
    });
    expect(result.intent.proposals).toEqual([
      {
        field: "device_name",
        currentValue: "",
        suggestedValue: "冷却泵",
        basis: "巡检单抬头",
        confidence: "high",
      },
    ]);
  });

  test("字段类型未知（fieldType=unknown）的字段上的建议同样被阻止，不出现在提案里", async () => {
    // def-row-analysis-no-proposal 生产 AC：错误提案须被字段校验阻止且可观测。
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: GridColumnDef[];
      suggestions: Array<{
        field: string;
        suggestedValue: unknown;
        basis: string;
        confidence: "high" | "medium" | "low";
      }>;
    }) => Promise<{ intent: { proposals: Array<{ field: string }> } }>;

    const result = await execute({
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
      fields: [
        ...fields,
        { key: "mystery", label: "未识别列", fieldType: "unknown" },
      ],
      values: { device_name: "", reading: 1000, created_at: "2026-05-01T00:00:00.000Z", mystery: "x" },
      suggestions: [
        { field: "mystery", suggestedValue: "补齐", basis: "模型猜测", confidence: "low" },
      ],
    });

    expect(result.intent.proposals).toEqual([]);
  });
});

describe("analyzeRow 提案字段名归一化", () => {
  test("建议 field 写成列 label（如「读数」）时归一到存储 key，取 currentValue 仍按 key", async () => {
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: GridColumnDef[];
      suggestions: Array<{ field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }>;
    }) => Promise<{ intent: { proposals: Array<{ field: string; currentValue: unknown }> } }>;

    const result = await execute({
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
      fields,
      values: { device_name: "", reading: 1000, created_at: "2026-05-01T00:00:00.000Z" },
      suggestions: [
        { field: "读数", suggestedValue: 1250, basis: "巡检附件二", confidence: "high" },
        { field: "不存在的字段", suggestedValue: "x", basis: "臆测", confidence: "low" },
      ],
    });

    expect(result.intent.proposals).toEqual([
      { field: "reading", currentValue: 1000, suggestedValue: 1250, basis: "巡检附件二", confidence: "high" },
    ]);
  });
});

describe("analyzeRow 归一化丢弃明细（PG-1 诊断 §3.3-2）", () => {
  const callAnalyze = async (input: {
    fields: GridColumnDef[];
    values: Record<string, unknown>;
    suggestions: Array<{ field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }>;
  }) => {
    const { analyzeRowTool } = await import("./row-analysis-tools");
    const execute = analyzeRowTool.execute as unknown as (input: {
      sheetId: string;
      recordId: string;
      values: Record<string, unknown>;
      fields: GridColumnDef[];
      suggestions: Array<{ field: string; suggestedValue: unknown; basis: string; confidence: "high" | "medium" | "low" }>;
    }) => Promise<{
      intent: {
        type: "row-patch-proposal";
        proposals: Array<{ field: string }>;
        dropped?: Array<{ field: string; reason: string }>;
      };
    }>;
    return execute({
      sheetId: "sheet:devices",
      recordId: "ent_devices:abc",
      fields: input.fields,
      values: input.values,
      suggestions: input.suggestions,
    });
  };

  test("未知字段丢弃记 unknown-field，不记业务值", async () => {
    const result = await callAnalyze({
      fields,
      values: { device_name: "", reading: 1000, created_at: "2026-05-01T00:00:00.000Z" },
      suggestions: [
        { field: "ghost_field", suggestedValue: "机密值", basis: "臆测", confidence: "low" },
      ],
    });
    expect(result.intent.proposals).toEqual([]);
    expect(result.intent.dropped).toEqual([{ field: "ghost_field", reason: "unknown-field" }]);
  });

  test("label 歧义（多列同名）丢弃记 ambiguous-label", async () => {
    const result = await callAnalyze({
      fields: [
        { key: "amount_a", label: "金额", fieldType: "currency" },
        { key: "amount_b", label: "金额", fieldType: "currency" },
      ],
      values: { amount_a: 1, amount_b: 2 },
      suggestions: [
        { field: "金额", suggestedValue: 999, basis: "附件", confidence: "medium" },
      ],
    });
    expect(result.intent.proposals).toEqual([]);
    expect(result.intent.dropped).toEqual([{ field: "金额", reason: "ambiguous-label" }]);
  });

  test("不可编辑字段（系统列 / unknown 类型）丢弃记 non-editable", async () => {
    const result = await callAnalyze({
      fields: [
        ...fields,
        { key: "mystery", label: "未识别列", fieldType: "unknown" },
      ],
      values: { device_name: "", reading: 1000, created_at: "x", mystery: "y" },
      suggestions: [
        { field: "created_at", suggestedValue: "2026-05-02T00:00:00.000Z", basis: "系统字段", confidence: "medium" },
        { field: "mystery", suggestedValue: "补齐", basis: "模型猜测", confidence: "low" },
      ],
    });
    expect(result.intent.proposals).toEqual([]);
    expect(result.intent.dropped).toEqual([
      { field: "created_at", reason: "non-editable" },
      { field: "mystery", reason: "non-editable" },
    ]);
  });

  test("无丢弃时 dropped 缺席（不污染存量 intent 形状）", async () => {
    const result = await callAnalyze({
      fields,
      values: { device_name: "", reading: 1000, created_at: "2026-05-01T00:00:00.000Z" },
      suggestions: [
        { field: "device_name", suggestedValue: "冷却泵", basis: "巡检单抬头", confidence: "high" },
      ],
    });
    expect(result.intent.proposals).toHaveLength(1);
    expect(result.intent.dropped).toBeUndefined();
  });

  test("proposeRecordWrite 有列定义时同样带回 dropped；无 session 透传时不记", async () => {
    const { proposeRecordWriteTool } = await import("./row-analysis-tools");
    const execute = proposeRecordWriteTool.execute as unknown as (input: {
      operation: "create";
      sheetId: string;
      proposals: Array<{ field: string; currentValue: unknown; suggestedValue: unknown; basis: string; confidence: "high" }>;
    }) => Promise<{
      intent: { type: string; proposals: Array<{ field: string }>; dropped?: Array<{ field: string; reason: string }> };
    }>;
    // 无 session：resolveProposalFieldDefs 返回 undefined，透传且不记 dropped。
    const passthrough = await execute({
      operation: "create",
      sheetId: "sheet:tasks",
      proposals: [{ field: "anything", currentValue: null, suggestedValue: "v", basis: "b", confidence: "high" }],
    });
    expect(passthrough.intent.proposals).toHaveLength(1);
    expect(passthrough.intent.dropped).toBeUndefined();
  });
});
