<script lang="ts">
  import { FileUp, X } from "@lucide/svelte";
  import type { ParsedCsvImport } from "../../../lib/csv-import";
  import { parseCsvImport } from "../../../lib/csv-import";
  import { editorStore } from "../../../lib/editor-store.svelte";
  import {
    templateSheetKeyForInstance,
  } from "../../../lib/workbook-templates";
  import { workbookTemplatesStore } from "../../../lib/workbook-templates.svelte";
  import {
    createTemplateSheetImportController,
    type TemplateImportTarget,
    type TemplateSheetImportControllerSnapshot,
  } from "../../../lib/template-sheet-import";
  import { editorUi } from "../lib/editor-ui.svelte";

  type Controller = ReturnType<typeof createTemplateSheetImportController>;

  let parsed = $state<ParsedCsvImport | null>(null);
  let controller = $state<Controller | null>(null);
  let view = $state<TemplateSheetImportControllerSnapshot | null>(null);
  let fileError = $state<string | null>(null);

  function close(): void {
    editorUi.showTemplateImport = false;
    parsed = null;
    controller = null;
    view = null;
    fileError = null;
  }

  function activeTargets(): TemplateImportTarget[] {
    const workbook = editorStore.workbook;
    const currentSheet = editorStore.sheets.find((sheet) => sheet.id === editorStore.activeSheetId);
    const template = workbook?.templateRef
      ? workbookTemplatesStore.templates.find((candidate) => candidate.id === workbook.templateRef)
      : undefined;
    const sheetKey = templateSheetKeyForInstance(template, currentSheet, editorStore.sheets);
    const templateFields = sheetKey
      ? template?.sheets.find((sheet) => sheet.key === sheetKey)?.columnDefs
      : undefined;
    const aliasesByKey = new Map((templateFields ?? []).map((field) => [field.key, field.aliases]));
    return editorStore.columns.map((column) => ({
      column,
      aliases: aliasesByKey.get(column.key),
    }));
  }

  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileError = null;
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error("请选择 CSV 文件");
      if (editorStore.workbook?.templateRef && workbookTemplatesStore.templates.length === 0) {
        await workbookTemplatesStore.load();
      }
      parsed = parseCsvImport(await file.text(), file.name);
      controller = createTemplateSheetImportController({
        parsed,
        targets: activeTargets(),
        importRows: (input) => editorStore.importCsvRows(input),
      });
      view = controller.snapshot;
    } catch (cause) {
      fileError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      input.value = "";
    }
  }

  function setMapping(sourceIndex: number, targetKey: string | null): void {
    controller?.setMapping(sourceIndex, targetKey);
    if (controller) view = controller.snapshot;
  }

  async function importAll(): Promise<void> {
    await controller?.importAll();
    if (controller) view = controller.snapshot;
  }

  function updateRejectedCell(rowNumber: number, sourceIndex: number, value: string): void {
    controller?.updateRejectedCell(rowNumber, sourceIndex, value);
    if (controller) view = controller.snapshot;
  }

  async function retryRejected(): Promise<void> {
    await controller?.retryRejected();
    if (controller) view = controller.snapshot;
  }
</script>

{#if editorUi.showTemplateImport}
  <div class="overlay" role="presentation">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="template-import-title">
      <header>
        <div><h2 id="template-import-title">导入 CSV 到当前数据表</h2><p>不会创建工作簿、数据表或字段</p></div>
        <button class="icon" type="button" aria-label="关闭导入" onclick={close}><X size={18} /></button>
      </header>

      <div class="body">
        {#if !parsed || !controller || !view}
          <label class="file-picker">
            <FileUp size={28} />
            <strong>选择 CSV 文件</strong>
            <span>使用当前数据表字段，支持中文表头</span>
            <input type="file" accept=".csv,text/csv" onchange={(event) => void chooseFile(event)} />
          </label>
          {#if fileError}<p class="error" role="alert">{fileError}</p>{/if}
        {:else if view.importedCount > 0 || view.rejected.length > 0}
          <div class="summary" aria-live="polite">
            <div><strong>{view.importedCount}</strong><span>成功记录</span></div>
            <div><strong>{view.rejected.length}</strong><span>失败记录</span></div>
          </div>
          {#if view.rejected.length > 0}
            <section class="rejections">
              <h3>拒绝报告</h3>
              {#each view.rejected as rejected}
                <article>
                  <div class="reject-head">
                    <strong>原文件第 {rejected.rowNumber} 行 · {rejected.field}</strong>
                    <span>{rejected.reason}</span>
                  </div>
                  <div class="retry-fields">
                    {#each parsed.fields as field}
                      <label>
                        <span>{field.label}</span>
                        <input
                          value={rejected.sourceCells[field.sourceIndex] ?? ""}
                          oninput={(event) => updateRejectedCell(
                            rejected.rowNumber,
                            field.sourceIndex,
                            event.currentTarget.value,
                          )}
                        />
                      </label>
                    {/each}
                  </div>
                </article>
              {/each}
            </section>
          {:else}
            <p class="done">全部记录已成功导入。</p>
          {/if}
          {#if view.error}<p class="error" role="alert">{view.error}</p>{/if}
        {:else}
          <section class="mapping">
            <div class="section-title"><h3>字段映射</h3><span>{parsed.rows.length} 条记录</span></div>
            {#each view.mappings as mapping}
              <label class="mapping-row">
                <span>{mapping.sourceLabel}</span>
                <select
                  value={mapping.targetKey ?? ""}
                  onchange={(event) => setMapping(mapping.sourceIndex, event.currentTarget.value || null)}
                >
                  <option value="">忽略该列</option>
                  {#each editorStore.columns as column}
                    <option value={column.key}>{column.label}</option>
                  {/each}
                </select>
              </label>
            {/each}
          </section>
          <section class="preview">
            <div class="section-title"><h3>数据预览</h3><span>前 {parsed.previewRows.length} 行</span></div>
            <div class="table-wrap"><table>
              <thead><tr>{#each parsed.fields as field}<th>{field.label}</th>{/each}</tr></thead>
              <tbody>{#each parsed.previewRows as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody>
            </table></div>
          </section>
        {/if}
      </div>

      <footer>
        <button class="secondary" type="button" onclick={close}>关闭</button>
        {#if parsed && controller && view}
          {#if view.rejected.length > 0}
            <button class="primary" type="button" disabled={view.importing} onclick={() => void retryRejected()}>
              {view.importing ? "正在重试…" : "仅重试失败记录"}
            </button>
          {:else if view.importedCount === 0}
            <button
              class="primary"
              type="button"
              disabled={view.importing || view.mappings.every((mapping) => !mapping.targetKey)}
              onclick={() => void importAll()}
            >{view.importing ? "正在导入…" : "确认导入"}</button>
          {/if}
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; z-index: 90; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(20 28 24 / 48%); }
  .dialog { display: flex; width: min(920px, 100%); max-height: min(820px, calc(100vh - 48px)); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: 0 24px 70px rgb(20 40 30 / 24%); }
  header, footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  footer { justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); border-bottom: 0; }
  h2, h3, p { margin: 0; } h2 { font-size: 18px; } h3 { font-size: 14px; }
  header p, .section-title span { margin-top: 3px; color: var(--text-3); font-size: 12px; }
  .icon { display: grid; width: 34px; height: 34px; place-items: center; border: 0; background: transparent; color: var(--text-2); }
  .body { overflow: auto; padding: 20px 22px; }
  .file-picker { display: grid; min-height: 260px; place-items: center; align-content: center; gap: 8px; border: 1px dashed var(--border); border-radius: 14px; color: var(--text-2); cursor: pointer; }
  .file-picker span { color: var(--text-3); font-size: 12px; } .file-picker input { display: none; }
  .mapping-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 1fr); align-items: center; gap: 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .mapping-row select, .retry-fields input { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface); color: var(--text-1); font: inherit; }
  .section-title { display: flex; align-items: end; justify-content: space-between; margin-bottom: 8px; }
  .preview, .rejections { margin-top: 20px; } .table-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: 12px; }
  th, td { padding: 8px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
  th { position: sticky; top: 0; background: var(--surface-2); }
  .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .summary div { display: grid; gap: 4px; padding: 18px; border-radius: 12px; background: var(--surface-2); text-align: center; }
  .summary strong { color: var(--primary); font-size: 28px; } .summary span { color: var(--text-3); font-size: 12px; }
  .rejections article { margin-top: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; }
  .reject-head { display: flex; justify-content: space-between; gap: 12px; color: var(--error); font-size: 12px; }
  .retry-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
  .retry-fields label { display: grid; gap: 5px; color: var(--text-3); font-size: 11px; }
  .error { margin-top: 12px; color: var(--error); font-size: 13px; } .done { padding: 28px; text-align: center; color: var(--primary); }
  button.primary, button.secondary { border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  button.primary { border: 1px solid var(--primary); background: var(--primary); color: white; }
  button.secondary { border: 1px solid var(--border); background: transparent; color: var(--text-2); }
  button:disabled { cursor: wait; opacity: .55; }
  @media (max-width: 680px) { .mapping-row, .retry-fields { grid-template-columns: 1fr; } }
</style>
