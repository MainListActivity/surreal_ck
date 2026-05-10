import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "../../../../shared/rpc.types";

const fields: GridColumnDef[] = [
  { key: "creditor_name", label: "债权人", fieldType: "text" },
  { key: "claim_amount", label: "债权金额", fieldType: "currency" },
  { key: "created_at", label: "创建时间", fieldType: "date" },
];

describe("analyzeClaimRow tool", () => {
  test("提案只包含当前数据表的可编辑字段", async () => {
    const { analyzeClaimRowTool } = await import("./claim-analysis-tools");
    const execute = analyzeClaimRowTool.execute as unknown as (input: {
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
        proposals: Array<{ field: string; currentValue: unknown; suggestedValue: unknown }>;
      };
    }>;

    const result = await execute({
      sheetId: "sheet:claims",
      recordId: "ent_claim:abc",
      fields,
      values: {
        creditor_name: "",
        claim_amount: 1000,
        created_at: "2026-05-01T00:00:00.000Z",
      },
      suggestions: [
        { field: "creditor_name", suggestedValue: "张三", basis: "申请书抬头", confidence: "high" },
        { field: "created_at", suggestedValue: "2026-05-02T00:00:00.000Z", basis: "系统字段", confidence: "medium" },
        { field: "ghost_field", suggestedValue: "忽略", basis: "不存在", confidence: "low" },
      ],
    });

    expect(result.intent).toMatchObject({
      type: "row-patch-proposal",
      recordId: "ent_claim:abc",
    });
    expect(result.intent.proposals).toEqual([
      {
        field: "creditor_name",
        currentValue: "",
        suggestedValue: "张三",
        basis: "申请书抬头",
        confidence: "high",
      },
    ]);
  });
});
