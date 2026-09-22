<script lang="ts">
  import { FileSpreadsheet, X } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { workbooksStore } from "../lib/workbooks.svelte";
  import { createImportBatchService, rejectedRowsToCsv } from "../lib/import-batch";
  import { createImportBatchUndoService, type ImportUndoPreview } from "../lib/import-batch-undo";
  import { getSurreal } from "../lib/surreal";
  import { convertCsvImportRows } from "../lib/csv-import";
  import type { ParsedXlsxImport, ParsedXlsxSheet } from "../lib/xlsx-import";
  import { suggestXlsxSheetTarget, type XlsxTemplateTarget } from "../lib/xlsx-template-import";
  import {
    mapCsvHeadersToTemplateFields,
    normalizeTemplateImportRows,
    type TemplateImportMapping,
  } from "../lib/template-sheet-import";
  import {
    createXlsxImportController,
    type XlsxImportControllerSnapshot,
    type XlsxSheetAction,
  } from "../lib/xlsx-import-controller";

  type ExistingTarget = {
    id: string;
    label: string;
    targets: XlsxTemplateTarget["targets"];
    importSheet: (
      sheet: ParsedXlsxSheet,
      batch?: { id: string; sheetName: string },
      mappings?: TemplateImportMapping[],
    ) => Promise<{ importedCount: number; skippedCount: number }>;
  };

  let {
    parsed,
    existingTargets = [],
    newWorkbookAllowed = true,
    onclose,
    onopen,
    onopenDataTable,
    onopenDashboard,
  }: {
    parsed: ParsedXlsxImport;
    existingTargets?: ExistingTarget[];
    newWorkbookAllowed?: boolean;
    onclose?: () => void;
    onopen?: (workbookId: string) => void;
    onopenDataTable?: (sheetId: string) => void | Promise<void>;
    onopenDashboard?: () => void | Promise<void>;
  } = $props();

  let workbookName = $state(untrack(() => parsed.workbookName));
  let activeSheetName = $state(untrack(() => parsed.sheets[0]?.name ?? ""));
  let error = $state<string | null>(null);
  const initialParsed = untrack(() => parsed);
  const initialNewWorkbookAllowed = untrack(() => newWorkbookAllowed);
  const initialExistingTargets = untrack(() => existingTargets);
  let mappingStates = $state<Record<string, { targetId: string; mappings: TemplateImportMapping[] }>>({});
  let undoPreview = $state<ImportUndoPreview | null>(null);
  let undoing = $state(false);

  function mappingsFor(sheet: ParsedXlsxSheet, targetId: string): TemplateImportMapping[] {
    const existing = mappingStates[sheet.name];
    if (existing?.targetId === targetId) return existing.mappings.map((mapping) => ({ ...mapping }));
    const target = initialExistingTargets.find((candidate) => candidate.id === targetId);
    const mappings = mapCsvHeadersToTemplateFields(
      sheet.fields.map((field) => field.label),
      target?.targets ?? [],
    );
    mappingStates[sheet.name] = { targetId, mappings };
    return mappings.map((mapping) => ({ ...mapping }));
  }

  const batchService = createImportBatchService(getSurreal());
  const undoService = createImportBatchUndoService(getSurreal());
  const controller = createXlsxImportController({
    parsed: initialParsed,
    batchService,
    resolveMappings: mappingsFor,
    existingTargetOrder: initialExistingTargets.map((target) => target.id),
    importNewWorkbook: async ({ workbookName, sheets, batch }) => {
      const imported = await workbooksStore.importXlsxWorkbook({ workbookName, sheets, batch });
      if (!imported) throw new Error(workbooksStore.error ?? "导入失败，请稍后重试");
      return { workbookId: imported.workbook.id, sheets: imported.sheets };
    },
    importExistingSheet: async ({ sheet, targetSheetId, batch }) => {
      const target = initialExistingTargets.find((candidate) => candidate.id === targetSheetId);
      if (!target) throw new Error("目标数据表不存在");
      return target.importSheet(sheet, batch, mappingsFor(sheet, targetSheetId));
    },
  });
  if (!initialNewWorkbookAllowed) {
    for (const sheet of initialParsed.sheets) {
      const suggestedTargetId = suggestXlsxSheetTarget(sheet, initialExistingTargets);
      controller.setAction(sheet.name, suggestedTargetId
        ? { kind: "map-existing", targetSheetId: suggestedTargetId }
        : { kind: "ignore" });
      if (suggestedTargetId) mappingsFor(sheet, suggestedTargetId);
    }
  }
  let view = $state<XlsxImportControllerSnapshot>(controller.snapshot);
  const activeSheet = $derived(parsed.sheets.find((sheet) => sheet.name === activeSheetName));
  const activeAction = $derived(view.actions.find((item) => item.sheetName === activeSheetName)?.action);
  const activeTarget = $derived(activeAction?.kind === "map-existing"
    ? initialExistingTargets.find((target) => target.id === activeAction.targetSheetId)
    : undefined);
  const activeMappings = $derived(activeSheet && activeTarget
    ? (mappingStates[activeSheet.name]?.mappings ?? [])
    : []);
  const finished = $derived(view.results.length > 0);

  function selectAction(sheetName: string, value: string): void {
    let action: XlsxSheetAction;
    if (value === "ignore") action = { kind: "ignore" };
    else if (value === "new-sheet") action = { kind: "new-sheet" };
    else action = { kind: "map-existing", targetSheetId: value.slice("map:".length) };
    controller.setAction(sheetName, action);
    if (action.kind === "map-existing") {
      const sheet = initialParsed.sheets.find((candidate) => candidate.name === sheetName);
      if (sheet) mappingsFor(sheet, action.targetSheetId);
    }
    view = controller.snapshot;
  }

  function setFieldMapping(sourceIndex: number, targetKey: string | null): void {
    if (!activeSheet || !activeTarget) return;
    const current = mappingsFor(activeSheet, activeTarget.id);
    mappingStates[activeSheet.name] = {
      targetId: activeTarget.id,
      mappings: current.map((mapping) => {
        if (mapping.sourceIndex === sourceIndex) return { ...mapping, targetKey, matchedBy: null };
        if (targetKey && mapping.targetKey === targetKey) return { ...mapping, targetKey: null, matchedBy: null };
        return mapping;
      }),
    };
  }

  function previewCell(sheet: ParsedXlsxSheet, row: string[], sourceIndex: number): string {
    const raw = row[sourceIndex] ?? "";
    let converted: unknown;
    if (activeTarget) {
      const targetKey = activeMappings.find((mapping) => mapping.sourceIndex === sourceIndex)?.targetKey;
      const target = activeTarget.targets.find((candidate) => candidate.column.key === targetKey);
      if (raw && target?.column.fieldType === "reference") return `${raw} → 导入时核验引用`;
      const normalized = normalizeTemplateImportRows({
        rows: [row],
        rowNumbers: [2],
        mappings: activeMappings,
        targets: activeTarget.targets,
      });
      converted = targetKey ? normalized.records[0]?.values[targetKey] : undefined;
      if (!normalized.records.length && raw) return `${raw} → 无法转换`;
    } else {
      converted = convertCsvImportRows([row], sheet.fields).records[0]?.[sheet.fields[sourceIndex]?.key ?? ""];
    }
    const rendered = converted instanceof Date
      ? converted.toISOString().slice(0, 10)
      : converted == null ? raw : String(converted);
    return rendered !== raw ? `${raw} → ${rendered}` : raw;
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

  async function refreshBatch(): Promise<void> {
    if (!view.batchId) return;
    await controller.recover(view.batchId);
    view = controller.snapshot;
  }

  async function previewUndo(): Promise<void> {
    if (!view.batchId) return;
    error = null;
    try {
      undoPreview = await undoService.preview(view.batchId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "撤销预检失败";
    }
  }

  async function confirmUndo(): Promise<void> {
    if (!view.batchId || undoPreview?.status !== "ready") return;
    undoing = true;
    error = null;
    try {
      const result = await undoService.undo(view.batchId, undoPreview.token);
      if (result.status === "conflict" && result.conflict) {
        undoPreview = result.conflict;
        error = "记录在确认前发生变化，已停止撤销，请重新预检";
        return;
      }
      undoPreview = await undoService.preview(view.batchId);
      await controller.recover(view.batchId);
      view = controller.snapshot;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "撤销失败";
    } finally {
      undoing = false;
    }
  }

  function downloadRejected(sheetName: string): void {
    const sheet = parsed.sheets.find((candidate) => candidate.name === sheetName);
    const result = view.results.find((candidate) => candidate.sheetName === sheetName);
    if (!sheet || !result?.rejected?.length) return;
    const rows = result.rejected
      .filter((row) => row.sourceCells)
      .map((row) => ({ ...row, sourceCells: row.sourceCells! }));
    if (!rows.length) return;
    const blob = new Blob([
      "\uFEFF",
      rejectedRowsToCsv(sheet.fields.map((field) => field.label), rows),
    ], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sheetName}-失败行.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
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
        {#if view.batchId}
          <div class="batch-state">
            <span>导入批次 {view.batchId}</span>
            <strong>{view.batchStatus === "outcome_unknown" ? "结果待核实" : view.batchStatus === "undone" ? "已撤销" : "结果已持久保存"}</strong>
            <button class="secondary" type="button" onclick={() => void refreshBatch()}>刷新批次结果</button>
            {#if view.batchStatus !== "undone"}<button class="secondary" type="button" onclick={() => void previewUndo()}>撤销预检</button>{/if}
          </div>
        {/if}
        {#if undoPreview}
          <section class="undo-preview">
            <h3>撤销预检</h3>
            {#if undoPreview.status === "ready"}
              <p>将仅删除本批次新增的 {undoPreview.deletableCount} 条记录，不删除工作簿、数据表或字段。</p>
              <button class="danger" type="button" disabled={undoing} onclick={() => void confirmUndo()}>{undoing ? "正在撤销…" : "确认撤销本批次"}</button>
            {:else if undoPreview.status === "already_undone"}
              <p>该批次已撤销，重复操作不会再次删除记录。</p>
            {:else}
              <p>当前无法整体撤销：</p>
              <ul>{#each undoPreview.blockers as blocker}<li>{blocker.message}</li>{/each}</ul>
            {/if}
          </section>
        {/if}
        {#if view.batchError}<p class="error" role="alert">{view.batchError}</p>{/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
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
                {#if item.rejected.some((row) => row.sourceCells)}
                  <button class="download" type="button" onclick={() => downloadRejected(item.sheetName)}>下载失败行</button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul></section>
      </div>
      <footer>
        <button class="secondary" type="button" onclick={close}>稍后查看</button>
        {#if view.firstImportedTargetId && onopenDataTable}
          <button class="secondary" type="button" onclick={() => void onopenDataTable?.(view.firstImportedTargetId!)}>查看数据表</button>
        {/if}
        {#if view.firstImportedTargetId && onopenDashboard}
          <button class="primary" type="button" onclick={() => void onopenDashboard?.()}>查看仪表盘</button>
        {/if}
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
          {#if activeTarget}
            <section><h3>字段映射 · {activeTarget.label}</h3><div class="mapping-list">
              {#each activeMappings as mapping}
                <label><span>{mapping.sourceLabel}</span><select value={mapping.targetKey ?? ""} onchange={(event) => setFieldMapping(mapping.sourceIndex, event.currentTarget.value || null)}>
                  <option value="">忽略该列</option>
                  {#each activeTarget.targets as target}<option value={target.column.key}>{target.column.label} · {target.column.fieldType}</option>{/each}
                </select></label>
              {/each}
            </div></section>
          {/if}
          <section><div class="section-head"><h3>数据预览 · {activeSheet.name}</h3><span>保留原始行号，前 {activeSheet.previewRows.length} 行</span></div>
            {#if activeSheet.fields.length}<div class="table-wrap"><table><thead><tr><th>原始行号</th>{#each activeSheet.fields as field}<th>{field.label}<small>{field.fieldType}</small></th>{/each}</tr></thead><tbody>{#each activeSheet.previewRows as row, rowIndex}<tr><td>{rowIndex + 2}</td>{#each activeSheet.fields as field}<td>{previewCell(activeSheet, row, field.sourceIndex)}</td>{/each}</tr>{/each}</tbody></table></div>{/if}
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
  .mapping-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; } .mapping-list label { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); align-items: center; gap: 8px; font-size: 12px; }
  .table-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; } th, td { padding: 8px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
  th { position: sticky; top: 0; background: var(--surface-2); }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .summary div { display: grid; gap: 4px; padding: 18px; border-radius: 12px; background: var(--surface-2); text-align: center; } .summary strong { color: var(--brand); font-size: 28px; } .summary span { font-size: 12px; }
  .batch-state { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font-size: 12px; } .batch-state strong { margin-left: auto; }
  .undo-preview { margin-bottom: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; } .undo-preview h3 { margin-top: 0; } .undo-preview p, .undo-preview li { font-size: 12px; } button.danger { border: 1px solid var(--danger, #b42318); border-radius: 9px; padding: 9px 16px; color: #fff; background: var(--danger, #b42318); font: inherit; font-weight: 600; cursor: pointer; }
  .results { display: grid; gap: 8px; padding: 0; list-style: none; } .results li { display: flex; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; } .results li.item-failed { border-color: var(--danger, #b42318); } .results span { color: var(--text-3); font-size: 12px; }
  .results li:has(.rejections) { flex-wrap: wrap; } .rejections { width: 100%; margin: 8px 0 0; padding-left: 20px; color: var(--danger, #b42318); font-size: 12px; } .rejections li { display: list-item; padding: 3px 0; border: 0; }
  .error { margin-top: 14px; color: var(--danger, #b42318); }
  th small { display: block; margin-top: 2px; color: var(--text-3); font-weight: 400; } .download { margin-top: 8px; border: 0; color: var(--brand); background: transparent; cursor: pointer; }
  button.primary, button.secondary { border-radius: 9px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; } button.primary { border: 1px solid var(--brand); color: #fff; background: var(--brand); } button.secondary { border: 1px solid var(--border); background: transparent; } button:disabled { opacity: .55; }
</style>
