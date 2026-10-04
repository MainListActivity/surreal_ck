<script lang="ts">
  import { Download, GitCompareArrows, RefreshCw, Send, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { DateTime } from "surrealdb";
  import { recalculateSubmission } from "../lib/claims-interest";
  import {
    FINDING_STATE_LABELS,
    RECON_CATEGORY_LABELS,
    buildReconciliationCsv,
    loadReconciliation,
    saveFinding,
    sendSupplementRequest,
    type ClaimSupplement,
    type ReconCategory,
    type ReconFinding,
    type ReconRow,
  } from "../lib/claims-reconcile";
  import { loadCurrentUser } from "../lib/profile-data";
  import { getSurreal } from "../lib/surreal";

  let { onclose }: { onclose?: () => void } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);
  let rows = $state<ReconRow[]>([]);
  let findings = $state<ReconFinding[]>([]);
  let supplements = $state<ClaimSupplement[]>([]);
  let selected = $state<ReconRow | null>(null);
  let actorName = $state("管理人");
  let filter = $state<"all" | ReconCategory>("all");
  let recalcBusy = $state(false);
  let actionBusy = $state(false);

  // 结论表单
  let findingState = $state<"open" | "waiting_creditor" | "resolved">("open");
  let findingNote = $state("");
  // 补充要求表单
  let supplementBody = $state("");

  function fmtAmount(value: number | null | undefined): string {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
  }

  function fmtTime(value: unknown): string {
    if (value instanceof DateTime) return value.toDate().toISOString().replace("T", " ").slice(0, 19);
    if (typeof value === "string") return value.replace("T", " ").slice(0, 19);
    return "—";
  }

  function segText(seg: Record<string, unknown>, key: "start" | "end" | "days" | "base" | "annual_rate" | "interest"): string {
    const value = seg[key];
    if (key === "annual_rate" && typeof value === "number") return (value * 100).toFixed(4) + "%";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
    return typeof value === "string" ? value : "—";
  }

  function idStr(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "toString" in value) return String(value);
    return "";
  }

  function findingFor(row: ReconRow): ReconFinding | undefined {
    return findings.find((f) => f.identity_code === row.identity_code);
  }

  function supplementsFor(row: ReconRow): ClaimSupplement[] {
    if (!row.submission_id) return [];
    return supplements.filter((s) => idStr(s.submission_id) === row.submission_id);
  }

  const filteredRows = $derived(
    filter === "all" ? rows : rows.filter((r) => r.categories.includes(filter as ReconCategory)),
  );

  const categoryCounts = $derived.by(() => {
    const counts = { amount_mismatch: 0, interest_mismatch: 0, missing_evidence: 0, identity_mismatch: 0 };
    for (const row of rows) {
      for (const c of row.categories) counts[c] += 1;
    }
    return counts;
  });

  function selectRow(row: ReconRow) {
    selected = row;
    supplementBody = "";
    const finding = findingFor(row);
    findingState = (finding?.state as typeof findingState) ?? "open";
    findingNote = typeof finding?.manager_note === "string" ? finding.manager_note : "";
  }

  async function reload() {
    busy = true;
    error = null;
    try {
      const db = getSurreal();
      const data = await loadReconciliation(db);
      rows = data.rows;
      findings = data.findings;
      supplements = data.supplements;
      if (selected) {
        selected = rows.find((r) => r.identity_code === selected!.identity_code) ?? null;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function recalcSelected() {
    if (!selected?.submission_id || recalcBusy) return;
    recalcBusy = true;
    error = null;
    try {
      const res = await recalculateSubmission(getSurreal(), selected.submission_id);
      if (!res.ok) {
        error = `重算失败：${res.error.code} · ${res.error.message}`;
      } else {
        await reload();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      recalcBusy = false;
    }
  }

  async function saveConclusion() {
    if (!selected || actionBusy) return;
    actionBusy = true;
    error = null;
    try {
      await saveFinding(getSurreal(), {
        identity_code: selected.identity_code,
        categories: selected.categories,
        manager_note: findingNote.trim() === "" ? null : findingNote.trim(),
        state: findingState,
        linked_submission_id: selected.submission_id,
        updated_by: actorName,
      });
      await reload();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      actionBusy = false;
    }
  }

  async function sendRequest() {
    if (!selected?.submission_id || actionBusy) return;
    actionBusy = true;
    error = null;
    try {
      await sendSupplementRequest(getSurreal(), {
        submission_id: selected.submission_id,
        body: supplementBody,
        actor: actorName,
      });
      supplementBody = "";
      await reload();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      actionBusy = false;
    }
  }

  function exportCsv() {
    const csv = buildReconciliationCsv(rows, findings);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claims-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onMount(async () => {
    try {
      const me = await loadCurrentUser(getSurreal());
      if (me) actorName = me.displayName ?? me.email;
    } catch {
      // actor 解析失败不阻塞加载，落库仍记录「管理人」。
    }
    await reload();
  });
</script>

<div class="overlay" role="presentation" onclick={() => !busy && onclose?.()}>
  <div
    class="dialog wide"
    role="dialog"
    aria-modal="true"
    aria-labelledby="claims-reconcile-title"
    onclick={(event) => event.stopPropagation()}
  >
    <header class="header">
      <div class="title-wrap">
        <GitCompareArrows size={18} />
        <h2 id="claims-reconcile-title">债权对账 · 并排差异</h2>
      </div>
      <div class="header-actions">
        <button type="button" class="ghost sm" disabled={busy} onclick={() => void reload()}>
          <RefreshCw size={13} />刷新
        </button>
        <button type="button" class="primary sm" disabled={busy || rows.length === 0} onclick={exportCsv}>
          <Download size={13} />导出 CSV
        </button>
        <button type="button" class="icon-btn" aria-label="关闭" disabled={busy} onclick={() => onclose?.()}>
          <X size={16} />
        </button>
      </div>
    </header>

    <p class="hint">
      每债权人一行：申报（债权人自述）/ 账面（企业台账聚合）/ 重算（interest-rules/v1 最新快照）三列并排。
      差异类别限四类；管理人结论与补充往返按债权人持久化。导出行数 = 下方债权人行数（{rows.length}）。
    </p>

    <div class="filters">
      <button type="button" class="chip" class:active={filter === "all"} onclick={() => (filter = "all")}>
        全部 {rows.length}
      </button>
      {#each Object.entries(RECON_CATEGORY_LABELS) as [key, label]}
        <button
          type="button"
          class="chip warn"
          class:active={filter === key}
          onclick={() => (filter = key as ReconCategory)}
        >
          {label} {categoryCounts[key as ReconCategory]}
        </button>
      {/each}
    </div>

    {#if error}
      <div class="status error" role="alert">{error}</div>
    {/if}

    <section class="panel">
      {#if busy && rows.length === 0}
        <p class="muted">加载中…</p>
      {:else if filteredRows.length === 0}
        <p class="muted">无匹配行。导入名册 / 台账并收债权人申报后出现在此。</p>
      {:else}
        <table class="recon">
          <thead>
            <tr>
              <th>债权人</th>
              <th class="num">申报本金</th>
              <th class="num">申报违约金</th>
              <th class="num">账面本金</th>
              <th class="num">账面利息</th>
              <th class="num">重算利息</th>
              <th class="num">重算合计</th>
              <th>差异</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredRows as row (row.identity_code)}
              <tr class:selected={selected?.identity_code === row.identity_code} onclick={() => selectRow(row)}>
                <td>
                  <div class="creditor">
                    <span class="name">{row.name ?? "（无名册）"}</span>
                    <span class="code">{row.identity_code}</span>
                  </div>
                </td>
                <td class="num">{row.submission_id ? fmtAmount(row.declared_principal) : "未申报"}</td>
                <td class="num">{row.submission_id ? fmtAmount(row.declared_penalty) : ""}</td>
                <td class="num">{fmtAmount(row.book_principal)}</td>
                <td class="num">{fmtAmount(row.book_interest)}</td>
                <td class="num">{row.calculation ? fmtAmount(row.calculation.total_interest) : "未重算"}</td>
                <td class="num">{row.calculation ? fmtAmount(row.calculation.total_amount) : ""}</td>
                <td>
                  {#if row.categories.length === 0}
                    <span class="badge ok">一致</span>
                  {:else}
                    {#each row.categories as c}
                      <span class="badge">{RECON_CATEGORY_LABELS[c]}</span>
                    {/each}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    {#if selected}
      <section class="panel detail">
        <h3>明细 · {selected.name ?? selected.identity_code}</h3>
        <div class="detail-grid">
          <div>
            <h4>重算分段 {selected.calculation ? `（${selected.calculation.rule_version}）` : ""}</h4>
            {#if selected.calculation?.segments?.length}
              <table class="segments">
                <thead>
                  <tr><th>起</th><th>止（不含）</th><th class="num">天数</th><th class="num">基数</th><th class="num">年利率</th><th class="num">利息</th></tr>
                </thead>
                <tbody>
                  {#each selected.calculation.segments as seg}
                    <tr>
                      <td>{segText(seg, "start")}</td>
                      <td>{segText(seg, "end")}</td>
                      <td class="num">{segText(seg, "days")}</td>
                      <td class="num">{segText(seg, "base")}</td>
                      <td class="num">{segText(seg, "annual_rate")}</td>
                      <td class="num">{segText(seg, "interest")}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <p class="muted">
                利息 {fmtAmount(selected.calculation.total_interest)} + 违约金 {fmtAmount(selected.calculation.penalty_amount)}
                = {fmtAmount(selected.calculation.total_amount)} · {fmtTime(selected.calculation.calculated_at)}
              </p>
            {:else}
              <p class="muted">{selected.submission_id ? "尚无重算快照。" : "无申报，不可重算。"}</p>
            {/if}
            {#if selected.submission_id}
              <button type="button" class="ghost sm" disabled={recalcBusy || actionBusy} onclick={() => void recalcSelected()}>
                <RefreshCw size={13} />{recalcBusy ? "重算中…" : "重新计算"}
              </button>
            {/if}
            {#if selected.attachments.length > 0}
              <p class="muted">附件 {selected.attachments.length} 份（{selected.attachments.map((a) => a.attachment_type ?? "?").join(" / ")}）</p>
            {/if}
          </div>

          <div>
            <h4>管理人结论</h4>
            <div class="form-row">
              <label>
                状态
                <select bind:value={findingState}>
                  {#each Object.entries(FINDING_STATE_LABELS) as [value, label]}
                    <option {value}>{label}</option>
                  {/each}
                </select>
              </label>
              <button type="button" class="primary sm" disabled={actionBusy} onclick={() => void saveConclusion()}>
                保存结论
              </button>
            </div>
            <textarea
              rows="3"
              maxlength="4096"
              placeholder="对该债权人差异的结论（内部字段，债权人不可见）"
              bind:value={findingNote}
            ></textarea>
            {#if findingFor(selected)?.updated_at}
              <p class="muted">
                最近更新：{findingFor(selected)!.updated_by ?? "?"} · {fmtTime(findingFor(selected)!.updated_at)}
              </p>
            {/if}

            <h4>补充往返</h4>
            {#if selected.submission_id}
              {@const thread = supplementsFor(selected)}
              {#if thread.length > 0}
                <ul class="thread">
                  {#each thread as msg (idStr(msg.id))}
                    <li class={msg.direction === "manager_request" ? "from-manager" : "from-creditor"}>
                      <div class="meta">
                        {msg.direction === "manager_request" ? "管理人要求" : "债权人回复"}
                        · {msg.actor ?? "?"} · {fmtTime(msg.created_at)}
                      </div>
                      <div class="body">{msg.body}</div>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="muted">暂无往返记录。</p>
              {/if}
              <textarea
                rows="2"
                maxlength="4000"
                placeholder="向债权人发出的补充要求（债权人可在其门户看到并回复）"
                bind:value={supplementBody}
              ></textarea>
              <button type="button" class="primary sm" disabled={actionBusy || supplementBody.trim().length === 0} onclick={() => void sendRequest()}>
                <Send size={13} />发出补充要求
              </button>
            {:else}
              <p class="muted">无申报行，无法发起补充往返。</p>
            {/if}
          </div>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(15 23 42 / 0.45);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 3vh 2vw;
    z-index: 60;
  }

  .dialog {
    background: var(--color-bg, #fff);
    color: var(--color-fg, #0f172a);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.25);
    padding: 20px 24px;
    width: min(860px, 96vw);
    max-height: 92vh;
    overflow-y: auto;
  }

  .dialog.wide {
    width: min(1180px, 96vw);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header h2 {
    font-size: 16px;
    margin: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hint, .muted {
    color: var(--color-muted, #64748b);
    font-size: 12px;
  }

  .filters {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 8px 0;
  }

  .chip {
    border: 1px solid var(--color-border, #e2e8f0);
    background: transparent;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    color: inherit;
  }

  .chip.active {
    background: var(--color-fg, #0f172a);
    color: var(--color-bg, #fff);
  }

  .panel {
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 8px;
    padding: 12px 14px;
    margin-top: 12px;
  }

  .panel h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }

  .panel h4 {
    margin: 12px 0 6px;
    font-size: 12px;
    color: var(--color-muted, #64748b);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th, td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--color-border, #e2e8f0);
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  tbody tr {
    cursor: pointer;
  }

  tbody tr:hover {
    background: rgb(148 163 184 / 0.08);
  }

  tbody tr.selected {
    background: rgb(59 130 246 / 0.1);
  }

  .creditor .name {
    display: block;
    font-weight: 500;
  }

  .creditor .code {
    font-size: 11px;
    color: var(--color-muted, #64748b);
    font-family: ui-monospace, monospace;
  }

  .badge {
    display: inline-block;
    padding: 1px 7px;
    margin-right: 4px;
    border-radius: 999px;
    font-size: 11px;
    background: rgb(251 146 60 / 0.15);
    color: #c2410c;
    border: 1px solid rgb(251 146 60 / 0.4);
  }

  .badge.ok {
    background: rgb(34 197 94 / 0.12);
    color: #15803d;
    border-color: rgb(34 197 94 / 0.35);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .form-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-bottom: 8px;
  }

  .form-row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-muted, #64748b);
  }

  select, textarea {
    font: inherit;
    font-size: 12px;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--color-bg, #fff);
    color: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .form-row select {
    width: auto;
  }

  textarea {
    resize: vertical;
    margin-bottom: 8px;
  }

  .thread {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    max-height: 160px;
    overflow-y: auto;
  }

  .thread li {
    border-radius: 6px;
    padding: 6px 9px;
    margin-bottom: 6px;
    font-size: 12px;
  }

  .thread .from-manager {
    background: rgb(59 130 246 / 0.08);
    border-left: 3px solid #3b82f6;
  }

  .thread .from-creditor {
    background: rgb(34 197 94 / 0.08);
    border-left: 3px solid #22c55e;
  }

  .thread .meta {
    color: var(--color-muted, #64748b);
    font-size: 11px;
    margin-bottom: 2px;
  }

  .thread .body {
    white-space: pre-wrap;
    word-break: break-word;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 5px 11px;
    font-size: 12px;
    cursor: pointer;
    background: var(--color-bg, #fff);
    color: inherit;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.primary {
    background: var(--color-fg, #0f172a);
    color: var(--color-bg, #fff);
    border-color: var(--color-fg, #0f172a);
  }

  button.icon-btn {
    border: none;
    background: transparent;
    padding: 4px;
  }

  .status.error {
    border: 1px solid rgb(239 68 68 / 0.4);
    background: rgb(239 68 68 / 0.08);
    color: #b91c1c;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    margin-top: 8px;
  }
</style>
