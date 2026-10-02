import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "@surreal-ck/shared/dto";
import type { ParsedXlsxSheet } from "./xlsx-import";
import { importXlsxSheetIntoTemplate, suggestXlsxSheetTarget } from "./xlsx-template-import";

const sheet: ParsedXlsxSheet = {
  name: "历史事项",
  status: "ready",
  issue: null,
  fields: [
    { key: "field_1", label: "填报人", fieldType: "text", sourceIndex: 0 },
    { key: "field_2", label: "事项登记金额", fieldType: "decimal", sourceIndex: 1 },
  ],
  rows: [["甲公司", "1,000"], ["乙公司", "待确认"]],
  previewRows: [],
};

describe("OIP-13 XLSX Sheet 映射已有模板数据表", () => {
  test("复用模板别名映射并把逐行拒绝结果返回给多 Sheet 汇总", async () => {
    const targets: Array<{ column: GridColumnDef; aliases?: string[] }> = [
      {
        column: { key: "owner_name", label: "负责人姓名", fieldType: "text" },
        aliases: ["填报人"],
      },
      {
        column: { key: "declared_amount", label: "登记金额", fieldType: "decimal" },
        aliases: ["事项登记金额"],
      },
    ];
    const result = await importXlsxSheetIntoTemplate({
      sheet,
      targets,
      importRows: async ({ rows, mappings }) => {
        expect(rows).toEqual(sheet.rows);
        expect(mappings.map(({ targetKey, matchedBy }) => ({ targetKey, matchedBy }))).toEqual([
          { targetKey: "owner_name", matchedBy: "alias" },
          { targetKey: "declared_amount", matchedBy: "alias" },
        ]);
        return {
          importedCount: 1,
          rejected: [{
            rowNumber: 3,
            field: "登记金额",
            reason: "值“待确认”不是有效金额/小数",
            sourceCells: ["乙公司", "待确认"],
          }],
        };
      },
    });

    expect(result).toEqual({
      importedCount: 1,
      skippedCount: 1,
      rejected: [{
        rowNumber: 3,
        field: "登记金额",
        reason: "值“待确认”不是有效金额/小数",
        sourceCells: ["乙公司", "待确认"],
      }],
    });
  });

  test("OIP-14 根据字段名与列别名唯一最高匹配自动建议模板数据表", () => {
    expect(suggestXlsxSheetTarget(sheet, [
      {
        id: "sheet:owners",
        targets: [
          { column: { key: "owner_name", label: "负责人姓名", fieldType: "text" }, aliases: ["填报人"] },
          { column: { key: "declared_amount", label: "登记金额", fieldType: "decimal" }, aliases: ["事项登记金额"] },
        ],
      },
      {
        id: "sheet:materials",
        targets: [
          { column: { key: "material_name", label: "材料名称", fieldType: "text" } },
          { column: { key: "owner", label: "关联负责人", fieldType: "reference" } },
        ],
      },
    ])).toBe("sheet:owners");
  });

  test("用户调整后的字段映射原样进入公开导入接口", async () => {
    const mappings = [
      { sourceIndex: 0, sourceLabel: "填报人", targetKey: null, matchedBy: null },
      { sourceIndex: 1, sourceLabel: "事项登记金额", targetKey: "manual_amount", matchedBy: null },
    ] as const;
    await importXlsxSheetIntoTemplate({
      sheet,
      targets: [{ column: { key: "manual_amount", label: "人工确认金额", fieldType: "decimal" } }],
      mappings: mappings.map((mapping) => ({ ...mapping })),
      importRows: async (input) => {
        expect(input.mappings).toEqual(mappings);
        return { importedCount: 1, rejected: [] };
      },
    });
  });
});
