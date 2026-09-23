import { describe, expect, test } from "bun:test";
import type { ParsedXlsxImport } from "./xlsx-import";
import { createXlsxImportController } from "./xlsx-import-controller";
import type { ImportBatchService, ImportBatchSnapshot } from "./import-batch";

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
      skippedCount: 1,
      successfulSheetCount: 2,
      failedSheetCount: 1,
      ignoredSheetCount: 1,
    });
    expect(controller.snapshot.results).toEqual([
      { sheetName: "债权", status: "success", importedCount: 2, skippedCount: 0, error: null },
      { sheetName: "材料", status: "success", importedCount: 1, skippedCount: 0, error: null },
      {
        sheetName: "待办",
        status: "failed",
        importedCount: 0,
        skippedCount: 1,
        error: "写入失败",
        rejected: [{ rowNumber: 2, field: "整条记录", reason: "写入失败", sourceCells: ["催收"] }],
      },
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

  test("确认后持久化批次，逐表写入携带批次身份并可从持久结果恢复", async () => {
    const events: string[] = [];
    const recovered: ImportBatchSnapshot = {
      id: "import_batch:b1",
      workbookId: null,
      fileName: "历史台账.xlsx",
      fileDigest: "digest",
      mappingVersion: "mapping",
      mode: "existing_tables",
      status: "partial_failure",
      startedAt: "2026-09-22T10:00:00Z",
      completedAt: "2026-09-22T10:01:00Z",
      updatedAt: "2026-09-22T10:01:00Z",
      sheets: [
        { sheetName: "债权", targetSheetId: "sheet:claims", mappingVersion: "mapping", status: "completed", importedCount: 2, rejectedCount: 0, error: null },
        { sheetName: "材料", targetSheetId: "sheet:evidence", mappingVersion: "mapping", status: "failed", importedCount: 0, rejectedCount: 1, error: "写入失败" },
      ],
      rows: [{ sheetName: "材料", rowNumber: 3, status: "rejected", targetRecordId: null, targetUpdatedAt: null, field: "整条记录", reason: "写入失败", sourceCells: ["合同"] }],
    };
    const batchService = {
      start: async () => { events.push("start"); return { id: "import_batch:b1" }; },
      finishSheet: async (_batchId: string, sheetName: string) => { events.push(`sheet:${sheetName}`); },
      finish: async (_batchId: string, status: string) => { events.push(`finish:${status}`); },
      load: async () => recovered,
    } as ImportBatchService;
    const controller = createXlsxImportController({
      parsed,
      batchService,
      importNewWorkbook: async () => ({ workbookId: "workbook:new", sheets: [] }),
      importExistingSheet: async ({ sheet, batch }) => {
        events.push(`write:${sheet.name}:${batch?.id}`);
        if (sheet.name === "材料") throw new Error("写入失败");
        return { importedCount: sheet.rows.length, skippedCount: 0 };
      },
    });
    controller.setAction("债权", { kind: "map-existing", targetSheetId: "sheet:claims" });
    controller.setAction("材料", { kind: "map-existing", targetSheetId: "sheet:evidence" });
    controller.setAction("待办", { kind: "ignore" });

    await controller.confirm();
    expect(events).toEqual([
      "start",
      "write:债权:import_batch:b1",
      "sheet:债权",
      "write:材料:import_batch:b1",
      "sheet:材料",
      "sheet:待办",
      "sheet:空表",
      "finish:partial_failure",
    ]);
    expect(controller.snapshot).toMatchObject({ batchId: "import_batch:b1", batchStatus: "partial_failure" });

    await controller.recover("import_batch:b1");
    expect(controller.snapshot.results).toEqual([
      { sheetName: "债权", status: "success", importedCount: 2, skippedCount: 0, error: null },
      { sheetName: "材料", status: "failed", importedCount: 0, skippedCount: 1, error: "写入失败", rejected: [{ rowNumber: 3, field: "整条记录", reason: "写入失败", sourceCells: ["合同"] }] },
    ]);
  });

  test("业务已提交但汇总回执更新断线时保留成功结果并标记待核实", async () => {
    const batchService = {
      start: async () => ({ id: "import_batch:b2" }),
      finishSheet: async () => { throw new Error("connection closed"); },
      finish: async () => undefined,
      load: async () => null,
      listRecent: async () => [],
    } as ImportBatchService;
    const controller = createXlsxImportController({
      parsed: { ...parsed, sheets: [parsed.sheets[0]!] },
      batchService,
      importNewWorkbook: async () => ({ workbookId: "workbook:new", sheets: [] }),
      importExistingSheet: async () => ({ importedCount: 2, skippedCount: 0 }),
    });
    controller.setAction("债权", { kind: "map-existing", targetSheetId: "sheet:claims" });

    await controller.confirm();

    expect(controller.snapshot.results).toEqual([
      { sheetName: "债权", status: "success", importedCount: 2, skippedCount: 0, error: null },
    ]);
    expect(controller.snapshot).toMatchObject({
      batchStatus: "outcome_unknown",
      batchError: expect.stringContaining("结果待核实"),
    });
  });

  test("恢复结果待核实批次时不会把仍在处理的 Sheet 误报为失败", async () => {
    const batchService = {
      load: async () => ({
        id: "import_batch:b3",
        workbookId: null,
        fileName: "历史台账.xlsx",
        fileDigest: "digest",
        mappingVersion: "mapping",
        mode: "existing_tables",
        status: "outcome_unknown",
        startedAt: "2026-09-22T10:00:00Z",
        completedAt: null,
        updatedAt: "2026-09-22T10:01:00Z",
        sheets: [{
          sheetName: "债权",
          targetSheetId: "sheet:claims",
          mappingVersion: "mapping",
          status: "processing",
          importedCount: 0,
          rejectedCount: 0,
          error: null,
        }],
        rows: [],
      }),
    } as unknown as ImportBatchService;
    const controller = createXlsxImportController({
      parsed,
      batchService,
      importNewWorkbook: async () => ({ workbookId: "workbook:new", sheets: [] }),
      importExistingSheet: async () => ({ importedCount: 0, skippedCount: 0 }),
    });

    await controller.recover("import_batch:b3");

    expect(controller.snapshot.results[0]?.status).toBe("outcome-unknown");
  });

  test("新工作簿提交响应断线后以同事务逐行回执恢复成功结果", async () => {
    const batchService = {
      start: async () => ({ id: "import_batch:b4" }),
      finishSheet: async () => undefined,
      finish: async () => undefined,
      load: async () => ({
        id: "import_batch:b4",
        workbookId: "workbook:created",
        fileName: "历史台账.xlsx",
        fileDigest: "digest",
        mappingVersion: "mapping",
        mode: "new_workbook",
        status: "processing",
        startedAt: "2026-09-22T10:00:00Z",
        completedAt: null,
        updatedAt: "2026-09-22T10:01:00Z",
        sheets: [],
        rows: [
          { sheetName: "债权", rowNumber: 2, status: "success", targetRecordId: "ent_claim:a", targetUpdatedAt: "2026-09-22T10:00:00Z", field: null, reason: null, sourceCells: [] },
          { sheetName: "债权", rowNumber: 3, status: "success", targetRecordId: "ent_claim:b", targetUpdatedAt: "2026-09-22T10:00:00Z", field: null, reason: null, sourceCells: [] },
        ],
      }),
    } as ImportBatchService;
    const controller = createXlsxImportController({
      parsed: { ...parsed, sheets: [parsed.sheets[0]!] },
      batchService,
      importNewWorkbook: async () => { throw new Error("connection closed"); },
      importExistingSheet: async () => ({ importedCount: 0, skippedCount: 0 }),
    });

    await controller.confirm();

    expect(controller.snapshot).toMatchObject({
      workbookId: "workbook:created",
      batchStatus: "completed",
      results: [{ sheetName: "债权", status: "success", importedCount: 2, skippedCount: 0 }],
    });
  });
});
