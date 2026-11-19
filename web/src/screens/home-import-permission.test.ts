import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readScreen(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

function readComponent(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8");
}

function readEditorFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../features/editor/${name}`, import.meta.url)), "utf8");
}

function importButton(home: string): string {
  return home.match(/<button[^>]*onclick=\{handleImportClick\}[\s\S]*?<\/button>/)?.[0] ?? "";
}

describe("CK 第六轮 · 首页建表导入入口提前说明管理员要求", () => {
  test("participant 下「导入文件」与相邻入口一致禁用并标注需要管理员权限", () => {
    const home = readScreen("HomeScreen.svelte");
    const button = importButton(home);

    expect(button).toContain("disabled={!canWriteSharedStructure}");
    expect(button).toContain('canWriteSharedStructure ? "Excel / CSV · 自动识别字段" : "需要管理员权限"');
    // 点击和文件变更都要提前拦住，不能落到向导里才报权限
    expect(home).toMatch(/function handleImportClick\(\) \{\s*if \(!canWriteSharedStructure\) return;/);
    expect(home).toMatch(/async function handleImportFile\(event: Event\): Promise<void> \{\s*if \(!canWriteSharedStructure\) return;/);
  });

  test("首页入口确认是建表路径：新建工作簿，不映射现有数据表", () => {
    const home = readScreen("HomeScreen.svelte");
    const csvDialog = readComponent("CsvImportDialog.svelte");
    const xlsxDialog = readComponent("XlsxImportDialog.svelte");
    const xlsxMount = home.match(/<XlsxImportDialog[\s\S]*?\/>/)?.[0] ?? "";

    expect(home).toContain("<CsvImportDialog");
    expect(home).toContain("<XlsxImportDialog");
    expect(csvDialog).toContain("workbooksStore.importCsvWorkbook");
    expect(xlsxDialog).toContain("workbooksStore.importXlsxWorkbook");
    expect(xlsxMount).not.toContain("existingTargets");
    expect(xlsxMount).not.toContain("newWorkbookAllowed={false}");
  });

  test("编辑器内写现有表的独立入口保留原有权限，不被结构门控误禁", () => {
    const toolbar = readEditorFile("EditorToolbar.svelte");
    const templateDialog = readEditorFile("modals/TemplateSheetImportDialog.svelte");
    const importToolbarButton = toolbar.match(/<button[^>]*onclick=\{\(\) => \(editorUi\.showTemplateImport = true\)\}[\s\S]*?<\/button>/)?.[0] ?? "";

    expect(importToolbarButton).not.toBe("");
    expect(toolbar).not.toContain("canWriteSharedStructure");
    expect(importToolbarButton).toContain("disabled={!editorStore.activeSheetId || editorStore.saving}");
    expect(templateDialog).toContain("newWorkbookAllowed={false}");
  });
});

describe("CK 第六轮 · 导入失败错误归属向导", () => {
  test("失败文案只在向导内展示，首页工作簿区仍只看页面 error", () => {
    const home = readScreen("HomeScreen.svelte");
    const csvDialog = readComponent("CsvImportDialog.svelte");
    const xlsxDialog = readComponent("XlsxImportDialog.svelte");

    expect(csvDialog).toContain("workbooksStore.importError");
    expect(xlsxDialog).toContain("workbooksStore.importError");
    expect(csvDialog).not.toContain("workbooksStore.error");
    expect(xlsxDialog).not.toContain("workbooksStore.error");
    expect(home).toContain("workbooksStore.error");
    expect(home).not.toContain("workbooksStore.importError");
  });

  test("关闭 CSV / XLSX 向导都会清理该次导入错误", () => {
    const home = readScreen("HomeScreen.svelte");
    const csvMount = home.match(/\{#if csvImport\}[\s\S]*?\{\/if\}/)?.[0] ?? "";
    const xlsxMount = home.match(/\{#if xlsxImport\}[\s\S]*?\{\/if\}/)?.[0] ?? "";

    expect(csvMount).toMatch(/onclose=\{\(\) => \{\s*workbooksStore\.clearImportError\(\);\s*csvImport = null;/);
    expect(xlsxMount).toMatch(/onclose=\{\(\) => \{\s*workbooksStore\.clearImportError\(\);\s*xlsxImport = null;/);
  });
});