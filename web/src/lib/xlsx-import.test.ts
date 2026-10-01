import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { parseXlsxImport } from "./xlsx-import";

function workbookBytes(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const claims = XLSX.utils.aoa_to_sheet([
    ["负责人姓名", "登记日期", "登记金额"],
    ...Array.from({ length: 24 }, (_, index) => [
      `负责人 ${index + 1}`,
      index === 0 ? new Date(Date.UTC(2026, 6, 1)) : `2026-07-${String(index + 1).padStart(2, "0")}`,
      index + 1,
    ]),
  ], { cellDates: true });
  XLSX.utils.book_append_sheet(workbook, claims, "事项登记表");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "空白附表");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["名称", "名称"],
    ["甲", "乙"],
  ]), "重复表头");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["内部编号"], ["1"]]), "内部数据");
  workbook.Workbook = {
    ...(workbook.Workbook ?? {}),
    Sheets: workbook.SheetNames.map((name) => ({ name, Hidden: name === "内部数据" ? 1 : 0 })),
  };
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", cellDates: true });
}

describe("OIP-13 XLSX 多 Sheet 解析", () => {
  test("列出所有可见中文 Sheet，并为每个 Sheet 独立生成表头与前 20 行预览", () => {
    const parsed = parseXlsxImport(workbookBytes(), "历史巡检台账.xlsx");

    expect(parsed.fileName).toBe("历史巡检台账.xlsx");
    expect(parsed.workbookName).toBe("历史巡检台账");
    expect(parsed.sheets.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "事项登记表", status: "ready" },
      { name: "空白附表", status: "empty" },
      { name: "重复表头", status: "invalid" },
    ]);
    expect(parsed.sheets[0]!.fields.map(({ label, fieldType }) => ({ label, fieldType }))).toEqual([
      { label: "负责人姓名", fieldType: "text" },
      { label: "登记日期", fieldType: "date" },
      { label: "登记金额", fieldType: "decimal" },
    ]);
    expect(parsed.sheets[0]!.previewRows).toHaveLength(20);
    expect(parsed.sheets[0]!.previewRows[0]).toEqual(["负责人 1", "2026-07-01", "1"]);
    expect(parsed.sheets[1]!.issue).toBe("Sheet 为空");
    expect(parsed.sheets[2]!.issue).toBe("存在重复表头：名称");
  });
});
