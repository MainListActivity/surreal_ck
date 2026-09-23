import { describe, expect, test } from "bun:test";
import type { SurrealConn } from "./surreal";
import { createImportBatchService, rejectedRowsToCsv } from "./import-batch";

describe("导入批次公开接口", () => {
  test("创建、更新并刷新恢复批次及逐表结果", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const conn = {
      createRecord: async (_table: string, data: Record<string, unknown>) => ({
        id: "import_batch:b1",
        ...data,
        started_at: "2026-09-22T10:00:00Z",
        updated_at: "2026-09-22T10:00:00Z",
      }),
      updateRecord: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { id, ...patch };
      },
      query: async (sql: string) => {
        if (/FROM import_batch_sheet/i.test(sql)) {
          return [{
            sheet_name: "债权",
            target_sheet: "sheet:s1",
            mapping_version: "map-v1",
            status: "completed",
            imported_count: 2,
            rejected_count: 1,
            error: null,
          }];
        }
        if (/FROM import_batch_row/i.test(sql)) {
          return [{
            sheet_name: "债权",
            source_row_number: 4,
            status: "rejected",
            target_record: null,
            field: "金额",
            reason: "不是有效金额",
            source_cells: ["甲", "待核"],
          }];
        }
        if (/FROM import_batch WHERE/i.test(sql)) {
          return [{
            id: "import_batch:b1",
            file_name: "历史台账.xlsx",
            file_digest: "digest-1",
            mapping_version: "map-v1",
            mode: "existing_tables",
            status: "partial_failure",
            started_at: "2026-09-22T10:00:00Z",
            completed_at: "2026-09-22T10:01:00Z",
            updated_at: "2026-09-22T10:01:00Z",
          }];
        }
        return [];
      },
    } as unknown as SurrealConn;
    const service = createImportBatchService(conn);

    const started = await service.start({
      fileName: "历史台账.xlsx",
      fileDigest: "digest-1",
      mappingVersion: "map-v1",
      mode: "existing_tables",
      sheets: [{ sheetName: "债权", targetSheetId: "sheet:s1", mappings: [] }],
    });
    await service.finishSheet(started.id, "债权", {
      status: "completed",
      importedCount: 2,
      rejectedCount: 1,
    });
    await service.finish(started.id, "partial_failure");
    const recovered = await service.load(started.id);

    expect(started.id).toBe("import_batch:b1");
    expect(updates.at(-1)).toEqual({
      id: "import_batch:b1",
      patch: { status: "partial_failure", completed_at: expect.anything() },
    });
    expect(recovered).toMatchObject({
      id: "import_batch:b1",
      status: "partial_failure",
      sheets: [{ sheetName: "债权", importedCount: 2, rejectedCount: 1 }],
      rows: [{ sheetName: "债权", rowNumber: 4, status: "rejected", sourceCells: ["甲", "待核"] }],
    });
  });

  test("失败行 CSV 保留原始行号，并安全编码可能触发表格公式的文本", () => {
    const csv = rejectedRowsToCsv(
      ["债权人", "说明"],
      [{ rowNumber: 8, field: "说明", reason: "待修正", sourceCells: ["=HYPERLINK(\"x\")", "+SUM(1,2)"] }],
    );

    expect(csv).toContain("原始行号,失败字段,失败原因,债权人,说明");
    expect(csv).toContain(`8,说明,待修正,"'=HYPERLINK(""x"")","'+SUM(1,2)"`);
  });
});
