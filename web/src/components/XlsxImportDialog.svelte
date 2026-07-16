<script lang="ts">
  import { FileSpreadsheet, X } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import type { ParsedXlsxImport, ParsedXlsxSheet } from "../lib/xlsx-import";
  import {
    createXlsxImportController,
    type XlsxImportControllerSnapshot,
    type XlsxSheetAction,
  } from "../lib/xlsx-import-controller";

  type ExistingTarget = {
    id: string;
    label: string;
    importSheet: (sheet: ParsedXlsxSheet) => Promise<{ importedCount: number; skippedCount: number }>;
  };

  let { parsed, existingTargets = [], newWorkbookAllowed = true, onclose, onopen }: {
    parsed: ParsedXlsxImport;
    existingTargets?: ExistingTarget[];
    newWorkbookAllowed?: boolean;
    onclose?: () => void;
    onopen?: (workbookId: string) => void;
  } = $props();

  let workbookName = $state(untrack(() => parsed.workbookName));
  let activeSheetName = $state(untrack(() => parsed.sheets[0]?.name ?? ""));
  let error = $state<string | null>(null);
  const initialParsed = untrack(() => parsed);
  const initialNewWorkbookAllowed = untrack(() => newWorkbookAllowed);
  const controller = createXlsxImportController({
    parsed: initialParsed,
    importNewWorkbook: async ({ workbookName, sheets }) => {
      const imported = await workbooksStore.importXlsxWorkbook({ workbookName, sheets });
      if (!imported) throw new Error(workbooksStore.error ?? "导入失败，请稍后重试");
      return { workbookId: imported.workbook.id, sheets: imported.sheets };
    },
    importExistingSheet: async ({ sheet, targetSheetId }) => {
      const target = existingTargets.find((candidate) => candidate.id === targetSheetId);
      if (!target) throw new Error("目标数据表不存在");
      return target.importSheet(sheet);
    },
  });
  if (!initialNewWorkbookAllowed) {
    for (const sheet of initialParsed.sheets) controller.setAction(sheet.name, { kind: "ignore" });
  }
  let view = $state<XlsxImportControllerSnapshot>(controller.snapshot);
  const activeSheet = $derived(parsed.sheets.find((sheet) => sheet.name === activeSheetName));
  const finished = $derived(view.results.length > 0);

  function selectAction(sheetName: string, value: string): void {
    let action: XlsxSheetAction;
    if (value === "ignore") action = { kind: "ignore" };
    else if (value === "new-sheet") action = { kind: "new-sheet" };
    else action = { kind: "map-existing", targetSheetId: value.slice("map:".length) };
    controller.setAction(sheetName, action);
    view = controller.snapshot;
  }

  function actionValue(sheetName: string): string {
    const action = view.actions.find((item) => item.sheetName === sheetName)?.action;
    return action?.kind === "map-existing" ? `map:${action.targetSheetId}` : action?.kind ?? "ignore";
  }

  async function confirm(): Promise<void> {
    if (newWorkbookAllowed && !workbookName.trim()) {
      error = "请输入工作簿名称";
      return;
    }
    error = null;
    await controller.confirm();
    view = controller.snapshot;
  }

  function close(): void {
    controller.cancel();
    onclose?.();
  }
</script>

<div class="overlay" role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="xlsx-import-title">
    <header>
      <div class="title"><FileSpreadsheet size={20} /><div><h2 id="xlsx-import-title">{finished ? "XLSX 导入完成" : "导入 XLSX"}</h2><p>{parsed.fileName}</p></div></div>
      <button class="icon" type="button" aria-label="关闭导入向导" onclick={close}><X size={18} /></button>
    </header>

    {#if finished}
      <div class="body complete" aria-live="polite">
        <div class="summary">
          <div><strong>{view.summary.importedCount}</strong><span>成功记录</span></div>
          <div><strong>{view.summary.skippedCount}</strong><span>跳过记录</span></div>
          <div><strong>{view.summary.successfulSheetCount}</strong><span>成功 Sheet</span></div>
        </div>
        <section><h3>逐 Sheet 结果</h3><ul class="results">
          {#each view.results as item}
            <li class:item-failed={item.status === "failed"}>
              <strong>{item.sheetName}</strong>
              <span>{item.status === "success" ? `成功 ${item.importedCount}，跳过 ${item.skippedCount}` : item.error ?? "已忽略"}</span>
              {#if item.rejected?.length}
                <ul class="rejections">{#each item.rejected as rejected}<li>原文件第 {rejected.rowNumber} 行 · {rejected.field}：{rejected.reason}</li>{/each}</ul>
              {/if}
            </li>
          {/each}
        </ul></section>
      </div>
      <footer>
        <button class="secondary" type="button" onclick={close}>稍后查看</button>
        {#if view.workbookId}<button class="primary" type="button" onclick={() => onopen?.(view.workbookId!)}>进入工作簿</button>{/if}
      </footer>
    {:else}
      <div class="body">
        {#if newWorkbookAllowed}<label class="workbook-name"><span>新工作簿名称</span><input bind:value={workbookName} maxlength="80" /></label>{/if}
        <section><h3>逐 Sheet 设置</h3><div class="sheet-list">
          {#each parsed.sheets as sheet}
            <div class:active={sheet.name === activeSheetName} class="sheet-row">
              <button type="button" onclick={() => (activeSheetName = sheet.name)}><strong>{sheet.name}</strong><small>{sheet.fields.length} 个字段 · {sheet.rows.length} 条记录</small></button>
              <select
                aria-label={`Sheet“${sheet.name}”的导入方式`}
                value={actionValue(sheet.name)}
                disabled={sheet.status !== "ready"}
                onchange={(event) => selectAction(sheet.name, event.currentTarget.value)}
              >
                <option value="ignore">忽略</option>
                {#if newWorkbookAllowed}<option value="new-sheet">新建数据表</option>{/if}
                {#each existingTargets as target}<option value={`map:${target.id}`}>映射：{target.label}</option>{/each}
              </select>
              {#if sheet.issue}<span class="issue">{sheet.issue}</span>{/if}
            </div>
          {/each}
        </div></section>
        {#if activeSheet}
          <section><div class="section-head"><h3>数据预览 · {activeSheet.name}</h3><span>前 {activeSheet.previewRows.length} 行</span></div>
            {#if activeSheet.fields.length}<div class="table-wrap"><table><thead><tr>{#each activeSheet.fields as field}<th>{field.label}</th>{/each}</tr></thead><tbody>{#each activeSheet.previewRows as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody></table></div>{/if}
          </section>
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
      <footer><button class="secondary" type="button" disabled={view.importing} onclick={close}>取消</button><button class="primary" type="button" disabled={view.importing} onclick={() => void confirm()}>{view.importing ? "正在导入…" : "确认导入"}</button></footer>
    {/if}
  </div>
</div>

<style>
  .overlay { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(20 28 24 / 48%); }
  .dialog { display: flex; width: min(980px, 100%); max-height: min(850px, calc(100vh - 48px)); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--surface, #fff); box-shadow: 0 24px 70px rgb(20 40 30 / 24%); }
  header, footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  footer { justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); border-bottom: 0; }
  .title { display: flex; align-items: center; gap: 12px; color: var(--brand); }
  h2, h3, p { margin: 0; } h2 { color: var(--text-1); font-size: 18px; } h3 { margin: 18px 0 10px; font-size: 14px; }
  header p, small, .section-head span { color: var(--text-3); font-size: 12px; }
  .icon { border: 0; color: var(--text-2); background: transparent; cursor: pointer; }
  .body { overflow: auto; padding: 20px 22px; }
  .workbook-name { display: grid; gap: 7px; font-size: 13px; font-weight: 600; }
  input, select { border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; color: var(--text-1); background: var(--surface); font: inherit; }
  .sheet-list { display: grid; gap: 8px; }
  .sheet-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; }
  .sheet-row.active { border-color: var(--brand); } .sheet-row > button { display: grid; gap: 3px; border: 0; text-align: left; background: transparent; cursor: pointer; }
  .issue { grid-column: 1 / -1; color: var(--danger, #b42318); font-size: 12px; }
  .section-head { display: flex; align-items: end; justify-content: space-between; }
  .table-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; } th, td { padding: 8px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
  th { position: sticky; top: 0; background: var(--surface-2); }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .summary div { display: grid; gap: 4px; padding: 18px; border-radius: 12px; background: var(--surface-2); text-align: center; } .summary strong { color: var(--brand); font-size: 28px; } .summary span { font-size: 12px; }
  .results { display: grid; gap: 8px; padding: 0; list-style: none; } .results li { display: flex; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; } .results li.item-failed { border-color: var(--danger, #b42318); } .results span { color: var(--text-3); font-size: 12px; }
  .results li:has(.rejections) { flex-wrap: wrap; } .rejections { width: 100%; margin: 8px 0 0; padding-left: 20px; color: var(--danger, #b42318); font-size: 12px; } .rejections li { display: list-item; padding: 3px 0; border: 0; }
  .error { margin-top: 14px; color: var(--danger, #b42318); }
  button.primary, button.secondary { border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; } button.primary { border: 1px solid var(--brand); color: #fff; background: var(--brand); } button.secondary { border: 1px solid var(--border); background: transparent; } button:disabled { opacity: .55; }
</style>
