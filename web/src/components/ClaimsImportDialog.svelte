<script lang="ts">
  import { Download, FileSpreadsheet, Upload, X } from "@lucide/svelte";
  import {
    formatClaimsImportSummary,
    importCreditorRoster,
    importEnterpriseLedger,
    LEDGER_TEMPLATE_PATH,
    ROSTER_TEMPLATE_PATH,
    type ClaimsImportWriteResult,
  } from "../lib/claims-excel-import";
  import { getSurreal } from "../lib/surreal";
  import { workbooksStore } from "../lib/workbooks.svelte";

  let {
    onclose,
    onopen,
  }: {
    onclose?: () => void;
    onopen?: (workbookId: string) => void;
  } = $props();

  let rosterInput = $state<HTMLInputElement>();
  let ledgerInput = $state<HTMLInputElement>();
  let busy = $state(false);
  let error = $state<string | null>(null);
  let lastResult = $state<ClaimsImportWriteResult | null>(null);
  let lastKind = $state<"roster" | "ledger" | null>(null);

  async function runImport(kind: "roster" | "ledger", file: File | undefined) {
    if (!file || busy) return;
    busy = true;
    error = null;
    lastResult = null;
    lastKind = kind;
    try {
      const data = await file.arrayBuffer();
      const conn = getSurreal();
      const result = kind === "roster"
        ? await importCreditorRoster(conn, data)
        : await importEnterpriseLedger(conn, data);
      lastResult = result;
      await workbooksStore.load();
      if (result.importedCount > 0 && result.workbookId) {
        // 保留对话框展示拒绝摘要，用户可手动打开工作簿。
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      if (kind === "roster" && rosterInput) rosterInput.value = "";
      if (kind === "ledger" && ledgerInput) ledgerInput.value = "";
    }
  }

  function handleRosterChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    void runImport("roster", input.files?.[0]);
  }

  function handleLedgerChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    void runImport("ledger", input.files?.[0]);
  }
</script>

<div class="overlay" role="presentation" onclick={() => !busy && onclose?.()}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="claims-import-title"
    onclick={(event) => event.stopPropagation()}
  >
    <header class="header">
      <div class="title-wrap">
        <FileSpreadsheet size={18} />
        <h2 id="claims-import-title">债权对账 · 名册与账面导入</h2>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭" disabled={busy} onclick={() => onclose?.()}>
        <X size={16} />
      </button>
    </header>

    <p class="hint">
      先下载模板填写，再导入。须先导名册，再导账面。企业行必须填对接联系人；识别码不能为空或重复；账面识别码必须已在名册。错误会指出 Excel 行号（表头为第 1 行）。
    </p>

    <section class="panel">
      <h3>债权人名册</h3>
      <div class="actions">
        <a class="secondary" href={ROSTER_TEMPLATE_PATH} download="creditor-roster.xlsx">
          <Download size={14} />下载名册模板
        </a>
        <input
          class="file-input"
          bind:this={rosterInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onchange={handleRosterChange}
        />
        <button type="button" class="primary" disabled={busy} onclick={() => rosterInput?.click()}>
          <Upload size={14} />{busy && lastKind === "roster" ? "导入中…" : "导入名册"}
        </button>
      </div>
    </section>

    <section class="panel">
      <h3>企业账面</h3>
      <div class="actions">
        <a class="secondary" href={LEDGER_TEMPLATE_PATH} download="enterprise-ledger.xlsx">
          <Download size={14} />下载账面模板
        </a>
        <input
          class="file-input"
          bind:this={ledgerInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onchange={handleLedgerChange}
        />
        <button type="button" class="primary" disabled={busy} onclick={() => ledgerInput?.click()}>
          <Upload size={14} />{busy && lastKind === "ledger" ? "导入中…" : "导入账面"}
        </button>
      </div>
    </section>

    {#if error}
      <div class="status error" role="alert">{error}</div>
    {/if}

    {#if lastResult}
      <div class="status" class:partial={lastResult.rejected.length > 0}>
        {formatClaimsImportSummary(lastResult)}
      </div>
      {#if lastResult.rejected.length}
        <ul class="rejects">
          {#each lastResult.rejected.slice(0, 20) as row}
            <li>第 {row.rowNumber} 行 · {row.field} · {row.reason}</li>
          {/each}
          {#if lastResult.rejected.length > 20}
            <li>…共 {lastResult.rejected.length} 处拒绝</li>
          {/if}
        </ul>
      {/if}
      {#if lastResult.workbookId}
        <button
          type="button"
          class="open-btn"
          disabled={busy}
          onclick={() => {
            onopen?.(lastResult!.workbookId!);
            onclose?.();
          }}
        >
          在现有表格中打开「债权对账」
        </button>
      {/if}
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: grid;
    place-items: center;
    z-index: 80;
    padding: 24px;
  }
  .dialog {
    width: min(560px, 100%);
    background: var(--surface, #fff);
    color: var(--text-1, #0f172a);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
    padding: 20px 22px 22px;
    display: grid;
    gap: 14px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
  }
  h3 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2, #475569);
  }
  .panel {
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
    padding: 12px 14px;
    background: var(--surface-2, #f8fafc);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .file-input {
    display: none;
  }
  a.secondary,
  button.primary,
  button.open-btn,
  button.icon-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 8px;
    font-size: 13px;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
  }
  a.secondary {
    padding: 7px 10px;
    background: #fff;
    border-color: var(--border, #e2e8f0);
    color: var(--text-1, #0f172a);
  }
  button.primary {
    padding: 7px 12px;
    background: #0f766e;
    color: #fff;
  }
  button.primary:disabled,
  button.open-btn:disabled,
  button.icon-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button.icon-btn {
    padding: 6px;
    background: transparent;
    color: var(--text-2, #475569);
  }
  button.open-btn {
    justify-content: center;
    padding: 9px 12px;
    background: #0f172a;
    color: #fff;
  }
  .status {
    font-size: 13px;
    line-height: 1.45;
    padding: 10px 12px;
    border-radius: 10px;
    background: #ecfdf5;
    color: #065f46;
  }
  .status.partial {
    background: #fff7ed;
    color: #9a3412;
  }
  .status.error {
    background: #fef2f2;
    color: #991b1b;
  }
  .rejects {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    color: var(--text-2, #475569);
    max-height: 160px;
    overflow: auto;
  }
</style>
