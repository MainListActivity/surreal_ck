import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "@surreal-ck/shared/rpc.types";
import {
  createTemplateSheetImportController,
  mapCsvHeadersToTemplateFields,
  normalizeTemplateImportRows,
} from "./template-sheet-import";
import { parseCsvImport } from "./csv-import";

describe("OIP-12 模板数据表 CSV 导入映射", () => {
  test("破产债权历史表头按字段名、模板别名、宽松文本的优先级自动对位", () => {
    const targets: Array<{ column: GridColumnDef; aliases?: string[] }> = [
      {
        column: { key: "creditor_name", label: "债权人名称", fieldType: "text" },
        aliases: ["申报人", "债权人"],
      },
      {
        column: { key: "declared_amount", label: "申报金额", fieldType: "decimal" },
        aliases: ["债权申报金额"],
      },
      {
        column: { key: "review_status", label: "审核状态", fieldType: "single_select" },
        aliases: ["状态"],
      },
    ];

    expect(mapCsvHeadersToTemplateFields(
      ["申报人", "债权 申报金额", "审核状态", "无关列"],
      targets,
    )).toEqual([
      { sourceIndex: 0, sourceLabel: "申报人", targetKey: "creditor_name", matchedBy: "alias" },
      { sourceIndex: 1, sourceLabel: "债权 申报金额", targetKey: "declared_amount", matchedBy: "relaxed" },
      { sourceIndex: 2, sourceLabel: "审核状态", targetKey: "review_status", matchedBy: "field-name" },
      { sourceIndex: 3, sourceLabel: "无关列", targetKey: null, matchedBy: null },
    ]);
  });

  test("精确字段名即使出现在别名列之后也优先占用目标字段", () => {
    const targets: Array<{ column: GridColumnDef; aliases?: string[] }> = [{
      column: { key: "review_status", label: "审核状态", fieldType: "single_select" },
      aliases: ["状态"],
    }];

    expect(mapCsvHeadersToTemplateFields(["状态", "审核状态"], targets)).toEqual([
      { sourceIndex: 0, sourceLabel: "状态", targetKey: null, matchedBy: null },
      { sourceIndex: 1, sourceLabel: "审核状态", targetKey: "review_status", matchedBy: "field-name" },
    ]);
  });

  test("按目标字段类型规整常见台账值，失败行保留原文件行号、字段和中文原因", () => {
    const targets: Array<{ column: GridColumnDef }> = [
      { column: { key: "amount", label: "申报金额", fieldType: "decimal" } },
      { column: { key: "count", label: "人数", fieldType: "number" } },
      { column: { key: "date", label: "申报日期", fieldType: "date" } },
      { column: { key: "missing", label: "是否缺失", fieldType: "checkbox" } },
      {
        column: {
          key: "status",
          label: "审核状态",
          fieldType: "single_select",
          options: ["待审核", "已确认"],
        },
      },
    ];
    const mappings = targets.map(({ column }, sourceIndex) => ({
      sourceIndex,
      sourceLabel: column.label,
      targetKey: column.key,
      matchedBy: "field-name" as const,
    }));

    expect(normalizeTemplateImportRows({
      rows: [
        ["￥1,234.50", "1,200", "2026/7/1", "是", "已 确认"],
        ["900", "2", "2026-07-02", "否", "已驳回"],
      ],
      mappings,
      targets,
    })).toEqual({
      records: [{
        rowNumber: 2,
        values: {
          amount: 1234.5,
          count: 1200,
          date: new Date("2026-07-01T00:00:00.000Z"),
          missing: true,
          status: "已确认",
        },
        sourceCells: ["￥1,234.50", "1,200", "2026/7/1", "是", "已 确认"],
      }],
      rejected: [{
        rowNumber: 3,
        field: "审核状态",
        reason: "值“已驳回”不在可选项中",
        sourceCells: ["900", "2", "2026-07-02", "否", "已驳回"],
      }],
    });
  });

  test("用户可覆盖或忽略映射，并且修正后只重试拒绝的原始行", async () => {
    const parsed = parseCsvImport(
      "申报人,债权申报金额,经办人,旧备注\n甲公司,1000,张三,保留\n乙公司,待确认,李四,忽略",
      "历史债权.csv",
    );
    const calls: Array<{ rows: string[][]; rowNumbers?: number[] }> = [];
    const controller = createTemplateSheetImportController({
      parsed,
      targets: [
        {
          column: { key: "creditor_name", label: "债权人名称", fieldType: "text" },
          aliases: ["申报人"],
        },
        {
          column: { key: "declared_amount", label: "申报金额", fieldType: "decimal" },
          aliases: ["债权申报金额"],
        },
        { column: { key: "contact_name", label: "联系人", fieldType: "text" } },
      ],
      importRows: async (input) => {
        calls.push({ rows: input.rows.map((row) => [...row]), rowNumbers: input.rowNumbers });
        if (!input.rowNumbers) {
          return {
            importedCount: 1,
            rejected: [{
              rowNumber: 3,
              field: "申报金额",
              reason: "值“待确认”不是有效金额/小数",
              sourceCells: [...input.rows[1]!],
            }],
          };
        }
        return { importedCount: 1, rejected: [] };
      },
    });

    controller.setMapping(2, "contact_name");
    controller.setMapping(3, null);
    await controller.importAll();
    controller.updateRejectedCell(3, 1, "900");
    await controller.retryRejected();

    expect(controller.snapshot.importedCount).toBe(2);
    expect(controller.snapshot.rejected).toEqual([]);
    expect(calls).toEqual([
      { rows: parsed.rows, rowNumbers: undefined },
      { rows: [["乙公司", "900", "李四", "忽略"]], rowNumbers: [3] },
    ]);
    expect(controller.snapshot.mappings.map(({ targetKey }) => targetKey)).toEqual([
      "creditor_name",
      "declared_amount",
      "contact_name",
      null,
    ]);
  });
});
