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
