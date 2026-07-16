import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("OIP-13 XLSX 多 Sheet 导入向导 UI", () => {
  test("首页通过 Worker 解析 XLSX，并打开支持逐 Sheet 配置、预览和汇总的向导", () => {
    const home = readFileSync(new URL("../../screens/HomeScreen.svelte", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("../../components/XlsxImportDialog.svelte", import.meta.url), "utf8");
    const editorDialog = readFileSync(new URL("./modals/TemplateSheetImportDialog.svelte", import.meta.url), "utf8");

    expect(home).toContain('accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"');
    expect(home).toContain("createXlsxParseTask(file)");
    expect(home).toContain("<XlsxImportDialog");
    expect(dialog).toContain("逐 Sheet 设置");
    expect(dialog).toContain('value="ignore"');
    expect(dialog).toContain('value="new-sheet"');
    expect(dialog).toContain("数据预览");
    expect(dialog).toContain("workbooksStore.importXlsxWorkbook");
    expect(dialog).toContain("成功记录");
    expect(dialog).toContain("跳过记录");
    expect(dialog).toContain("逐 Sheet 结果");
    expect(editorDialog).toContain('accept=".csv,.xlsx');
    expect(editorDialog).toContain("newWorkbookAllowed={false}");
    expect(editorDialog).toContain("importXlsxSheetIntoTemplate");
  });
});
