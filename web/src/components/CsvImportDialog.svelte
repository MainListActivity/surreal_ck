<script lang="ts">
  import { FileSpreadsheet, X } from "@lucide/svelte";
  import { untrack } from "svelte";
  import type { CsvWorkbookImportResult } from "../lib/workbooks";
  import {
    type CsvImportField,
    type CsvImportFieldType,
    type ParsedCsvImport,
  } from "../lib/csv-import";
  import { workbooksStore } from "../lib/workbooks.svelte";

  let { parsed, onclose, onopen }: {
    parsed: ParsedCsvImport;
    onclose?: () => void;
    onopen?: (workbookId: string) => void;
  } = $props();

  const typeOptions: Array<{ value: CsvImportFieldType; label: string }> = [
    { value: "text", label: "文本" },
    { value: "number", label: "数字" },
    { value: "decimal", label: "金额/小数" },
    { value: "date", label: "日期" },
  ];

  let workbookName = $state(untrack(() => parsed.workbookName));
  let fields = $state<CsvImportField[]>(untrack(() => parsed.fields.map((field) => ({ ...field }))));
  let importing = $state(false);
  let error = $state<string | null>(null);
  let result = $state<CsvWorkbookImportResult | null>(null);

  function updateField(index: number, patch: Partial<CsvImportField>): void {
    fields = fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field);
  }

  async function confirmImport(): Promise<void> {
    if (importing) return;
    error = null;
    if (!workbookName.trim()) {
      error = "请输入工作簿名称";
      return;
    }
    if (fields.some((field) => !field.label.trim())) {
      error = "字段名称不能为空";
      return;
    }
    importing = true;
    try {
      result = await workbooksStore.importCsvWorkbook({
        workbookName,
        sheetLabel: workbookName,
        fields,
        rows: parsed.rows,
      });
      if (!result) error = workbooksStore.error ?? "导入失败，请稍后重试";
    } finally {
      importing = false;
    }
  }

  function openImportedWorkbook(): void {
    if (result) onopen?.(result.workbook.id);
  }
</script>

<div class="csv-overlay" role="presentation">
  <div class="csv-dialog" role="dialog" aria-modal="true" aria-labelledby="csv-import-title">
    <header>
      <div class="title-row">
        <span class="file-icon"><FileSpreadsheet size={20} /></span>
        <div>
          <h2 id="csv-import-title">{result ? "CSV 导入完成" : "导入 CSV"}</h2>
          <p>{parsed.fileName}</p>
        </div>
      </div>
      <button class="icon-button" type="button" aria-label="关闭导入向导" onclick={() => onclose?.()}>
        <X size={18} />
      </button>
    </header>

    {#if result}
      <div class="complete" aria-live="polite">
        <div class="result-counts">
          <div><strong>{result.importedCount}</strong><span>成功记录</span></div>
          <div><strong>{result.skippedCount}</strong><span>跳过记录</span></div>
          <div><strong>{result.fields.length}</strong><span>识别字段</span></div>
        </div>
        <div class="recognized-fields">
          <h3>字段识别结果</h3>
          <ul>
            {#each result.fields as field}
              <li>
                <span>{field.label}</span>
                <em>{typeOptions.find((option) => option.value === field.fieldType)?.label ?? field.fieldType}</em>
              </li>
            {/each}
          </ul>
        </div>
      </div>
      <footer>
        <button class="secondary" type="button" onclick={() => onclose?.()}>稍后查看</button>
        <button class="primary" type="button" onclick={openImportedWorkbook}>进入数据表</button>
      </footer>
    {:else}
      <div class="body">
        <label class="workbook-name">
          <span>新工作簿名称</span>
          <input bind:value={workbookName} maxlength="80" />
        </label>

        <section class="mapping" aria-labelledby="field-mapping-title">
          <div class="section-head">
            <h3 id="field-mapping-title">确认字段</h3>
            <span>{fields.length} 个字段 · {parsed.rows.length} 条记录</span>
          </div>
          <div class="field-list">
            {#each fields as field, index}
              <div class="field-row">
                <input
                  aria-label={`第 ${index + 1} 个字段名称`}
                  value={field.label}
                  maxlength="80"
                  oninput={(event) => updateField(index, { label: event.currentTarget.value })}
                />
                <select
                  aria-label={`字段“${field.label}”的类型`}
                  value={field.fieldType}
                  onchange={(event) => updateField(index, { fieldType: event.currentTarget.value as CsvImportFieldType })}
                >
                  {#each typeOptions as option}<option value={option.value}>{option.label}</option>{/each}
                </select>
              </div>
            {/each}
          </div>
        </section>

        <section class="preview" aria-labelledby="csv-preview-title">
          <div class="section-head">
            <h3 id="csv-preview-title">数据预览</h3>
            <span>前 {parsed.previewRows.length} 行</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>{#each fields as field}<th>{field.label || field.key}</th>{/each}</tr></thead>
              <tbody>
                {#each parsed.previewRows as row}
                  <tr>{#each fields as field}<td>{row[field.sourceIndex] ?? ""}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
      <footer>
        <button class="secondary" type="button" disabled={importing} onclick={() => onclose?.()}>取消</button>
        <button class="primary" type="button" disabled={importing} onclick={() => void confirmImport()}>
          {importing ? "正在导入…" : "确认导入"}
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .csv-overlay { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(20 28 24 / 48%); }
  .csv-dialog { display: flex; width: min(920px, 100%); max-height: min(820px, calc(100vh - 48px)); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--surface, #fff); box-shadow: 0 24px 70px rgb(20 40 30 / 24%); }
  header, footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  footer { justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); border-bottom: 0; }
  .title-row { display: flex; align-items: center; gap: 12px; }
  .file-icon { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 10px; color: var(--brand); background: var(--brand-soft); }
  h2, h3, p { margin: 0; }
  h2 { font-size: 18px; }
  header p, .section-head span { margin-top: 3px; color: var(--text-3); font-size: 12px; }
  .icon-button { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: 8px; color: var(--text-2); background: transparent; cursor: pointer; }
  .body, .complete { overflow: auto; padding: 20px 22px; }
  .workbook-name { display: grid; gap: 7px; color: var(--text-2); font-size: 13px; font-weight: 600; }
  input, select { min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; color: var(--text-1); background: var(--surface, #fff); font: inherit; }
  .mapping, .preview { margin-top: 20px; }
  .section-head { display: flex; align-items: end; justify-content: space-between; margin-bottom: 10px; }
  .section-head h3, .recognized-fields h3 { font-size: 14px; }
  .field-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .field-row { display: grid; grid-template-columns: minmax(0, 1fr) 132px; gap: 8px; }
  .table-wrap { max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
  th, td { max-width: 240px; overflow: hidden; padding: 8px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; text-overflow: ellipsis; }
  th { position: sticky; top: 0; color: var(--text-2); background: var(--surface-2, #f7f9f7); }
  .error { margin-top: 14px; color: var(--danger, #b42318); font-size: 13px; }
  button.primary, button.secondary { border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  button.primary { border: 1px solid var(--brand); color: #fff; background: var(--brand); }
  button.secondary { border: 1px solid var(--border); color: var(--text-2); background: transparent; }
  button:disabled { cursor: wait; opacity: .55; }
  .result-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .result-counts div { display: grid; gap: 4px; padding: 18px; border-radius: 12px; background: var(--surface-2, #f7f9f7); text-align: center; }
  .result-counts strong { color: var(--brand); font-size: 28px; }
  .result-counts span { color: var(--text-3); font-size: 12px; }
  .recognized-fields { margin-top: 22px; }
  .recognized-fields ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 0; list-style: none; }
  .recognized-fields li { display: flex; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; }
  .recognized-fields em { color: var(--text-3); font-size: 12px; font-style: normal; }
  @media (max-width: 680px) {
    .field-list, .recognized-fields ul { grid-template-columns: 1fr; }
    .field-row { grid-template-columns: minmax(0, 1fr) 120px; }
  }
</style>
