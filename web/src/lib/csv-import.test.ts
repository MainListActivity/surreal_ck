import { describe, expect, test } from "bun:test";
import { convertCsvImportRows, parseCsvImport } from "./csv-import";

describe("parseCsvImport — UTF-8 CSV 解析与字段推断", () => {
  test("解析 BOM、中文表头、引号与至少前 20 行预览", () => {
    const body = Array.from({ length: 24 }, (_, index) =>
      `债权人${index + 1},\"备注,第 ${index + 1} 行\",${1000 + index}`
    ).join("\r\n");

    const parsed = parseCsvImport(`\uFEFF债权人名称,备注,申报金额\r\n${body}`, "历史债权.csv");

    expect(parsed.fileName).toBe("历史债权.csv");
    expect(parsed.workbookName).toBe("历史债权");
    expect(parsed.fields.map(({ label, fieldType }) => ({ label, fieldType }))).toEqual([
      { label: "债权人名称", fieldType: "text" },
      { label: "备注", fieldType: "text" },
      { label: "申报金额", fieldType: "decimal" },
    ]);
    expect(parsed.previewRows).toHaveLength(20);
    expect(parsed.rows).toHaveLength(24);
    expect(parsed.previewRows[0]).toEqual(["债权人1", "备注,第 1 行", "1000"]);
  });

  test("独立推断整数、金额、日期和全空字段", () => {
    const parsed = parseCsvImport(
      [
        "序号,合同金额,签订日期,补充说明",
        "1,￥1,234.50,2026-07-01,",
        "2,2000,2026/07/02,",
        "3,,2026年7月3日,",
      ].join("\n").replace("￥1,234.50", "\"￥1,234.50\""),
      "合同.csv",
    );

    expect(parsed.fields.map((field) => field.fieldType)).toEqual([
      "number",
      "decimal",
      "date",
      "text",
    ]);
  });
});

describe("convertCsvImportRows — 用户确认后的类型转换", () => {
  test("使用用户修改的字段名称和类型，空值不写入记录", () => {
    const parsed = parseCsvImport("编号,金额,日期\n001,1,2026-07-01\n002,,", "台账.csv");
    const fields = parsed.fields.map((field) =>
      field.label === "编号"
        ? { ...field, label: "债权编号", fieldType: "text" as const }
        : field
    );

    const converted = convertCsvImportRows(parsed.rows, fields);

    expect(converted.skipped).toEqual([]);
    expect(converted.records[0]).toEqual({
      field_1: "001",
      field_2: 1,
      field_3: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(converted.records[1]).toEqual({ field_1: "002" });
  });

  test("用户把字段改成不兼容类型时跳过整条记录并保留原文件行号", () => {
    const parsed = parseCsvImport("名称,金额\n甲公司,100\n乙公司,待确认\n,", "债权.csv");
    const fields = parsed.fields.map((field) =>
      field.label === "金额" ? { ...field, fieldType: "decimal" as const } : field
    );

    const converted = convertCsvImportRows(parsed.rows, fields);

    expect(converted.records).toEqual([{ field_1: "甲公司", field_2: 100 }]);
    expect(converted.skipped).toEqual([
      { rowNumber: 3, reason: "字段“金额”不是有效金额/小数" },
      { rowNumber: 4, reason: "空白记录" },
    ]);
  });
});
