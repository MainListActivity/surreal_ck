<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { X } from "@lucide/svelte";
  import { createDataCheckService, type DataCheckRunSnapshot } from "../../../lib/data-check-runtime";
  import { getSurreal } from "../../../lib/surreal";
  import { editorStore } from "../../../lib/editor-store.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import { openDataTableRuntime, type DataTableRuntime, type RecordFieldRepairPlan } from "../../../lib/data-table-runtime";
  import { markFindingNotApplicable, startFindingProcessing } from "../../../lib/finding-repair";
  import type { DataCheckFinding } from "../../../lib/data-check-runtime";

  const service = createDataCheckService(getSurreal());
  let result = $state<DataCheckRunSnapshot | null>(null);
  let running = $state(false);
  let abortController = $state<AbortController | null>(null);
  let loadedWorkbookId = $state<string | null>(null);
  let activeFinding = $state<DataCheckFinding | null>(null);
  let repairValue = $state("");
  let repairPlan = $state<RecordFieldRepairPlan | null>(null);
  let repairRuntime = $state<DataTableRuntime | null>(null);
  let repairKey = $state("");
  let dispositionReason = $state("");
  let actionError = $state("");
  let actionBusy = $state(false);

  onMount(() => {
    void restoreLatest();
  });
  onDestroy(() => {
    abortController?.abort();
    void repairRuntime?.close();
    editorUi.showDataCheck = false;
  });
  $effect(() => {
    const workbookId = editorStore.workbook?.id ?? null;
    if (workbookId === loadedWorkbookId) return;
    loadedWorkbookId = workbookId;
    result = null;
    abortController?.abort();
    if (workbookId) void restoreLatest();
  });

  async function restoreLatest(): Promise<void> {
    const workbookId = editorStore.workbook?.id;
    if (!workbookId) return;
    result = await service.loadLatest(workbookId).catch(() => null);
  }

  async function startCheck(): Promise<void> {
    const workbookId = editorStore.workbook?.id;
    if (!workbookId || running) return;
    abortController = new AbortController();
    running = true;
    try {
      result = await service.start({
        workbookId,
        signal: abortController.signal,
        onProgress: (progress) => { result = progress; },
      });
    } finally {
      running = false;
      abortController = null;
    }
  }

  async function locate(sheetId: string, recordId: string): Promise<void> {
    await editorStore.switchSheet(sheetId);
    editorUi.selectRow(recordId as import("@surreal-ck/shared").RecordIdString);
    editorUi.openPanel("detail");
    editorUi.showDataCheck = false;
  }

  async function chooseFinding(finding: DataCheckFinding): Promise<void> {
    await repairRuntime?.close();
    repairRuntime = null;
    activeFinding = finding;
    repairValue = "";
    repairPlan = null;
    repairKey = crypto.randomUUID();
    dispositionReason = "";
    actionError = "";
    try {
      await startFindingProcessing(getSurreal(), {
        findingId: finding.id,
        idempotencyKey: `processing:${finding.id}:${finding.evidenceFingerprint}`,
      });
      finding.status = "processing";
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function previewRepair(): Promise<void> {
    const finding = activeFinding;
    const workbookId = editorStore.workbook?.id;
    if (!finding || !workbookId || finding.field.includes(",")) return;
    actionBusy = true;
    actionError = "";
    try {
      repairRuntime ??= await openDataTableRuntime({
        conn: getSurreal(), workbookId, dataTableId: finding.sheetId,
        query: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
      });
      const planned = await repairRuntime.planRecordFieldRepair({
        recordId: finding.recordId as import("@surreal-ck/shared").RecordIdString,
        fieldKey: finding.field,
        value: repairValue,
      });
      if (!planned.ok) throw new Error(planned.error.message);
      repairPlan = planned.value;
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      actionBusy = false;
    }
  }

  async function confirmRepair(): Promise<void> {
    if (!activeFinding || !repairPlan || !repairRuntime) return;
    actionBusy = true;
    actionError = "";
    try {
      const confirmed = await repairRuntime.confirmRecordFieldRepair({
        token: repairPlan.token, findingId: activeFinding.id,
        idempotencyKey: `repair:${activeFinding.id}:${repairKey}`,
      });
      if (!confirmed.ok) throw new Error(confirmed.error.message);
      if (result) result = await service.load(result.id);
      activeFinding = null;
      repairPlan = null;
      await repairRuntime.close();
      repairRuntime = null;
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      actionBusy = false;
    }
  }

  async function markNotApplicable(): Promise<void> {
    if (!activeFinding) return;
    actionBusy = true;
    actionError = "";
    try {
      await markFindingNotApplicable(getSurreal(), {
        findingId: activeFinding.id, reason: dispositionReason,
        idempotencyKey: `not-applicable:${activeFinding.id}:${repairKey}`,
      });
      if (result) result = await service.load(result.id);
      activeFinding = null;
    } catch (cause) {
      actionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      actionBusy = false;
    }
  }

  const categoryLabel = (category: DataCheckRunSnapshot["findings"][number]["category"]): string => ({
    required: "必填",
    format: "格式",
    duplicate_candidate: "重复候选",
    reference_missing: "引用缺失",
    reference_unverifiable: "引用无法核验",
    consistency: "字段一致性",
  })[category];
  const statusLabel = (status: DataCheckFinding["status"]): string => ({ pending: "待处理", processing: "处理中", pending_review: "待复核", closed: "已关闭", not_applicable: "不适用" })[status];
</script>

{#if editorUi.showDataCheck}
  <div class="overlay" role="presentation"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="data-check-title">
    <header><div><h2 id="data-check-title">全范围数据体检</h2><p>检查字段约束及模板跨记录规则，不受当前 500 条视图窗口限制</p></div><button class="icon" aria-label="关闭" onclick={() => (editorUi.showDataCheck = false)}><X size={18} /></button></header>
    <div class="body">
      {#if result}
        <div class="summary"><strong>{result.scannedCount}</strong><span>已扫描记录</span><strong>{result.findingCount}</strong><span>发现问题</span><strong>{result.status}</strong><span>运行状态</span></div>
        {#if result.stale}<p class="warning">扫描期间数据发生变化，结果待重检，不代表一致性快照。</p>{/if}
        {#if result.error}<p class="error">{result.error}</p>{/if}
        {#if result.status === "completed" && !result.stale && result.findingCount === 0}<p class="clean">完整扫描范围内未发现问题。</p>{/if}
        <p class="version">规则版本：{result.rulesVersion}</p>
        {#if result.findings.length}<ul class="findings">{#each result.findings as finding}<li><div><strong>{categoryLabel(finding.category)} · {finding.field}</strong><span>{finding.explanation} · 规则 {finding.ruleKey}@{finding.ruleVersion}</span><small>{statusLabel(finding.status)} · {finding.sheetId} / {finding.recordId}</small></div><div class="finding-actions"><button onclick={() => void locate(finding.sheetId, finding.recordId)}>定位记录</button><button disabled={finding.status === "closed" || finding.status === "not_applicable"} onclick={() => void chooseFinding(finding)}>处理</button></div></li>{/each}</ul>{/if}
        {#if activeFinding}<section class="repair"><h3>处理问题</h3><p>{activeFinding.recordId} · {activeFinding.field}</p><small>确认时会重新核对原值；若他人已修改，本次操作不会覆盖。</small>
          {#if !activeFinding.field.includes(",") && activeFinding.category !== "duplicate_candidate"}
            <label>修正值<input bind:value={repairValue} disabled={!!repairPlan || actionBusy} /></label>
            {#if repairPlan}<div class="diff"><span>修正前：{String(repairPlan.before ?? "（空）")}</span><strong>→</strong><span>修正后：{String(repairPlan.after ?? "（空）")}</span></div><button class="primary" disabled={actionBusy} onclick={() => void confirmRepair()}>确认修正并提交复核</button>{:else}<button disabled={actionBusy} onclick={() => void previewRepair()}>预览字段差异</button>{/if}
          {/if}
          <label>不适用理由<textarea bind:value={dispositionReason} maxlength="500"></textarea></label><button disabled={actionBusy} onclick={() => void markNotApplicable()}>标记不适用</button>
          {#if actionError}<p class="error">{actionError}</p>{/if}<button onclick={() => (activeFinding = null)}>取消处理</button>
        </section>{/if}
      {:else}<p class="empty">尚未运行数据体检。</p>{/if}
    </div>
    <footer><button class="secondary" onclick={() => (editorUi.showDataCheck = false)}>关闭</button>{#if running}<button class="danger" onclick={() => abortController?.abort()}>取消检查</button>{:else}<button class="primary" onclick={() => void startCheck()}>{result ? "重新检查" : "开始检查"}</button>{/if}</footer>
  </div></div>
{/if}

<style>
  .overlay { position: fixed; z-index: 95; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(20 28 24 / 48%); }
  .dialog { display: flex; width: min(880px, 100%); max-height: calc(100vh - 48px); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
  header, footer { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); } footer { justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border); border-bottom: 0; }
  h2, p { margin: 0; } header p { margin-top: 4px; color: var(--text-3); font-size: 12px; } .icon { border: 0; background: transparent; }
  .body { overflow: auto; padding: 20px 22px; } .summary { display: grid; grid-template-columns: repeat(3, auto 1fr); gap: 8px; align-items: baseline; padding: 12px; border-radius: 10px; background: var(--surface-2); } .summary strong { color: var(--primary); }
  .warning, .error, .clean, .empty { margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 12px; } .warning { color: #8a4b00; background: #fff4df; } .error { color: var(--error); } .clean { color: var(--success); background: var(--surface-2); }
  .version { margin-top: 10px; color: var(--text-3); font-size: 11px; }
  .findings { display: grid; gap: 8px; padding: 0; list-style: none; } .findings li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; } .findings div { display: grid; gap: 3px; } .findings span, .findings small { color: var(--text-3); font-size: 12px; }
  .finding-actions { display: flex !important; grid-auto-flow: column; } .repair { display: grid; gap: 10px; margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); } .repair h3 { margin: 0; } .repair label { display: grid; gap: 5px; font-size: 12px; } .repair input, .repair textarea { padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); } .diff { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
  button { border-radius: 8px; padding: 8px 12px; border: 1px solid var(--border); background: transparent; } .primary { color: white; border-color: var(--primary); background: var(--primary); } .danger { color: white; border-color: var(--error); background: var(--error); }
</style>
