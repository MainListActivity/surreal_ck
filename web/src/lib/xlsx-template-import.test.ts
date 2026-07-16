import { describe, expect, test } from "bun:test";
import type { GridColumnDef } from "@surreal-ck/shared/rpc.types";
import type { ParsedXlsxSheet } from "./xlsx-import";
import { importXlsxSheetIntoTemplate, suggestXlsxSheetTarget } from "./xlsx-template-import";

const sheet: ParsedXlsxSheet = {
  name: "历史债权",
  status: "ready",
  issue: null,
  fields: [
    { key: "field_1", label: "申报人", fieldType: "text", sourceIndex: 0 },
    { key: "field_2", label: "债权申报金额", fieldType: "decimal", sourceIndex: 1 },
  ],
  rows: [["甲公司", "1,000"], ["乙公司", "待确认"]],
  previewRows: [],
};

describe("OIP-13 XLSX Sheet 映射已有模板数据表", () => {
  test("复用模板别名映射并把逐行拒绝结果返回给多 Sheet 汇总", async () => {
    const targets: Array<{ column: GridColumnDef; aliases?: string[] }> = [
      {
        column: { key: "creditor_name", label: "债权人名称", fieldType: "text" },
        aliases: ["申报人"],
      },
      {
        column: { key: "declared_amount", label: "申报金额", fieldType: "decimal" },
        aliases: ["债权申报金额"],
      },
    ];
    const result = await importXlsxSheetIntoTemplate({
      sheet,
      targets,
      importRows: async ({ rows, mappings }) => {
        expect(rows).toEqual(sheet.rows);
        expect(mappings.map(({ targetKey, matchedBy }) => ({ targetKey, matchedBy }))).toEqual([
          { targetKey: "creditor_name", matchedBy: "alias" },
          { targetKey: "declared_amount", matchedBy: "alias" },
        ]);
        return {
          importedCount: 1,
          rejected: [{
            rowNumber: 3,
            field: "申报金额",
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
        field: "申报金额",
        reason: "值“待确认”不是有效金额/小数",
        sourceCells: ["乙公司", "待确认"],
      }],
    });
  });

  test("OIP-14 根据字段名与列别名唯一最高匹配自动建议模板数据表", () => {
    expect(suggestXlsxSheetTarget(sheet, [
      {
        id: "sheet:creditors",
        targets: [
          { column: { key: "creditor_name", label: "债权人名称", fieldType: "text" }, aliases: ["申报人"] },
          { column: { key: "declared_amount", label: "申报金额", fieldType: "decimal" }, aliases: ["债权申报金额"] },
        ],
      },
      {
        id: "sheet:materials",
        targets: [
          { column: { key: "material_name", label: "材料名称", fieldType: "text" } },
          { column: { key: "creditor", label: "关联债权人", fieldType: "reference" } },
        ],
      },
    ])).toBe("sheet:creditors");
  });
});
