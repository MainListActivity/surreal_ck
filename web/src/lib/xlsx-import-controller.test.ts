import { describe, expect, test } from "bun:test";
import type { ParsedXlsxImport } from "./xlsx-import";
import { createXlsxImportController } from "./xlsx-import-controller";

const parsed: ParsedXlsxImport = {
  fileName: "历史台账.xlsx",
  workbookName: "历史台账",
  sheets: [
    { name: "债权", status: "ready", issue: null, fields: [], rows: [["甲"], ["乙"]], previewRows: [] },
    { name: "材料", status: "ready", issue: null, fields: [], rows: [["合同"]], previewRows: [] },
    { name: "待办", status: "ready", issue: null, fields: [], rows: [["催收"]], previewRows: [] },
    { name: "空表", status: "empty", issue: "Sheet 为空", fields: [], rows: [], previewRows: [] },
  ],
};

describe("OIP-13 多 Sheet 导入控制器", () => {
  test("一次原子提交所有新建数据表，并逐个映射已有数据表后汇总独立结果", async () => {
    const newWorkbookCalls: string[][] = [];
    const mappedCalls: Array<{ sheet: string; target: string }> = [];
    const controller = createXlsxImportController({
      parsed,
      importNewWorkbook: async ({ sheets }) => {
        newWorkbookCalls.push(sheets.map((sheet) => sheet.name));
        return {
          workbookId: "workbook:new",
          sheets: sheets.map((sheet) => ({
            sheetName: sheet.name,
            importedCount: sheet.rows.length,
            skippedCount: 0,
          })),
        };
      },
      importExistingSheet: async ({ sheet, targetSheetId }) => {
        mappedCalls.push({ sheet: sheet.name, target: targetSheetId });
        if (sheet.name === "待办") throw new Error("写入失败\n    at database.ts:42");
        return { importedCount: 1, skippedCount: 0 };
      },
    });

    controller.setAction("材料", { kind: "map-existing", targetSheetId: "sheet:evidence" });
    controller.setAction("待办", { kind: "map-existing", targetSheetId: "sheet:tasks" });
    await controller.confirm();

    expect(newWorkbookCalls).toEqual([["债权"]]);
    expect(mappedCalls).toEqual([
      { sheet: "材料", target: "sheet:evidence" },
      { sheet: "待办", target: "sheet:tasks" },
    ]);
    expect(controller.snapshot.summary).toEqual({
      importedCount: 3,
      skippedCount: 0,
      successfulSheetCount: 2,
      failedSheetCount: 1,
      ignoredSheetCount: 1,
    });
    expect(controller.snapshot.results).toEqual([
      { sheetName: "债权", status: "success", importedCount: 2, skippedCount: 0, error: null },
      { sheetName: "材料", status: "success", importedCount: 1, skippedCount: 0, error: null },
      { sheetName: "待办", status: "failed", importedCount: 0, skippedCount: 0, error: "写入失败" },
      { sheetName: "空表", status: "ignored", importedCount: 0, skippedCount: 0, error: "Sheet 为空" },
    ]);
  });

  test("用户在确认前取消后不会执行任何导入", async () => {
    let calls = 0;
    const controller = createXlsxImportController({
      parsed,
      importNewWorkbook: async () => {
        calls += 1;
        return { workbookId: "workbook:new", sheets: [] };
      },
      importExistingSheet: async () => {
        calls += 1;
        return { importedCount: 0, skippedCount: 0 };
      },
    });

    controller.cancel();
    await controller.confirm();

    expect(calls).toBe(0);
    expect(controller.snapshot.cancelled).toBe(true);
  });

  test("OIP-14 映射到模板时按目标数据表顺序导入以先建立被引用记录", async () => {
    const importOrder: string[] = [];
    const reordered: ParsedXlsxImport = {
      ...parsed,
      sheets: [parsed.sheets[1]!, parsed.sheets[0]!, parsed.sheets[2]!],
    };
    const controller = createXlsxImportController({
      parsed: reordered,
      existingTargetOrder: ["sheet:creditors", "sheet:materials", "sheet:tasks"],
      importNewWorkbook: async () => ({ workbookId: "workbook:new", sheets: [] }),
      importExistingSheet: async ({ targetSheetId }) => {
        importOrder.push(targetSheetId);
        return { importedCount: 1, skippedCount: 0 };
      },
    });

    controller.setAction("债权", { kind: "map-existing", targetSheetId: "sheet:creditors" });
    controller.setAction("材料", { kind: "map-existing", targetSheetId: "sheet:materials" });
    controller.setAction("待办", { kind: "map-existing", targetSheetId: "sheet:tasks" });
    await controller.confirm();

    expect(importOrder).toEqual(["sheet:creditors", "sheet:materials", "sheet:tasks"]);
    expect(controller.snapshot.results.map((result) => result.sheetName)).toEqual(["材料", "债权", "待办"]);
    expect(controller.snapshot.firstImportedTargetId).toBe("sheet:creditors");
  });
});
