import { describe, expect, test } from "bun:test";

const root = import.meta.dir;
const read = (path: string) => Bun.file(`${root}/${path}`).text();

describe("OIP-12 编辑器模板数据表 CSV 导入", () => {
  test("活动数据表工具栏打开导入对话框，对话框走当前运行时并支持仅重试失败记录", async () => {
    const [toolbar, screen, dialog] = await Promise.all([
      read("EditorToolbar.svelte"),
      read("../../screens/EditorScreen.svelte"),
      read("modals/TemplateSheetImportDialog.svelte"),
    ]);

    expect(toolbar).toContain("导入 CSV");
    expect(toolbar).toContain("editorUi.showTemplateImport = true");
    expect(screen).toContain("<TemplateSheetImportDialog />");
    expect(dialog).toContain("createTemplateSheetImportController");
    expect(dialog).toContain("editorStore.importCsvRows");
    expect(dialog).toContain("忽略该列");
    expect(dialog).toContain("仅重试失败记录");
  });
});
