<script lang="ts">
  import { Calculator, RefreshCw, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { DateTime } from "surrealdb";
  import {
    listClaimSubmissions,
    listInterestCalculations,
    recalculateSubmission,
    type ClaimSubmissionListItem,
    type InterestCalculationRow,
    type RecalculateResult,
  } from "../lib/claims-interest";
  import { getSurreal } from "../lib/surreal";

  let { onclose }: { onclose?: () => void } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);
  let submissions = $state<ClaimSubmissionListItem[]>([]);
  let selected = $state<ClaimSubmissionListItem | null>(null);
  let calculations = $state<InterestCalculationRow[]>([]);
  let lastResult = $state<RecalculateResult | null>(null);
  let recalcBusyId = $state<string | null>(null);

  function fmtAmount(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    return value.toFixed(2);
  }

  function fmtTime(value: unknown): string {
    if (value instanceof DateTime) return value.toDate().toISOString().replace("T", " ").slice(0, 19);
    if (typeof value === "string") return value.replace("T", " ").slice(0, 19);
    return "—";
  }

  async function loadCalculations(submissionId: string) {
    const db = getSurreal();
    calculations = await listInterestCalculations(db, submissionId);
  }

  async function selectSubmission(item: ClaimSubmissionListItem) {
    selected = item;
    lastResult = null;
    error = null;
    calculations = [];
    try {
      await loadCalculations(item.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function recalc(item: ClaimSubmissionListItem) {
    if (busy || recalcBusyId) return;
    recalcBusyId = item.id;
    error = null;
    lastResult = null;
    try {
      const db = getSurreal();
      const res = await recalculateSubmission(db, item.id);
      lastResult = res;
      if (res.ok) await loadCalculations(item.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      recalcBusyId = null;
    }
  }

  onMount(async () => {
    busy = true;
    error = null;
    try {
      const db = getSurreal();
      submissions = await listClaimSubmissions(db);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  });
</script>

<div class="overlay" role="presentation" onclick={() => !busy && onclose?.()}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="claims-interest-title"
    onclick={(event) => event.stopPropagation()}
  >
    <header class="header">
      <div class="title-wrap">
        <Calculator size={18} />
        <h2 id="claims-interest-title">债权对账 · 利息重算</h2>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭" disabled={busy} onclick={() => onclose?.()}>
        <X size={16} />
      </button>
    </header>

    <p class="hint">
      按合同分段利率对债权人申报做单利重算（interest-rules/v1，半开区间 [起,止)，年日因子 365，逐段到分）。
      每次重算追加一条不可变快照；只读申报数据，不改名册和账面。
    </p>

    <section class="panel">
      <h3>债权人申报</h3>
      {#if busy}
        <p class="muted">加载中…</p>
      {:else if submissions.length === 0}
        <p class="muted">暂无申报。债权人经令牌链接填写并「保存草稿」后即出现在此列表。</p>
      {:else}
        <table class="submissions">
          <thead>
            <tr><th>识别码</th><th>本金</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {#each submissions as item}
              <tr class:selected={selected?.id === item.id}>
                <td>
                  <button type="button" class="link" onclick={() => void selectSubmission(item)}>
                    {item.identity_code || item.id}
                  </button>
                </td>
                <td class="num">{fmtAmount(item.principal)}</td>
                <td>{item.status}</td>
                <td class="num">
                  <button
                    type="button"
                    class="primary sm"
                    disabled={busy || recalcBusyId !== null}
                    onclick={() => void recalc(item)}
                  >
                    <RefreshCw size={13} />{recalcBusyId === item.id ? "重算中…" : "重算"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    {#if selected}
      <section class="panel">
        <h3>重算结果 · {selected.identity_code || selected.id}</h3>
        {#if lastResult && !lastResult.ok}
          <div class="status error" role="alert">
            计算失败：{lastResult.error.code} · {lastResult.error.message}
          </div>
        {/if}
        {#if lastResult?.ok}
          <table class="segments">
            <thead>
              <tr><th>段</th><th>起</th><th>止（不含）</th><th class="num">天数</th><th class="num">基数</th><th class="num">年利率</th><th class="num">利息</th></tr>
            </thead>
            <tbody>
              {#each lastResult.result.segments as seg}
                <tr>
                  <td>{seg.index + 1}</td><td>{seg.start}</td><td>{seg.end}</td>
                  <td class="num">{seg.days}</td><td class="num">{fmtAmount(seg.base)}</td>
                  <td class="num">{seg.annual_rate}</td><td class="num">{fmtAmount(seg.interest)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="totals">
            <span>合计利息 <strong>{fmtAmount(lastResult.result.total_interest)}</strong></span>
            <span>违约金 <strong>{fmtAmount(lastResult.result.penalty_amount)}</strong></span>
            <span>合计 <strong>{fmtAmount(lastResult.result.total_amount)}</strong></span>
            <span class="muted">规则版本 {lastResult.result.rule_version} · 快照 {lastResult.calculation_id}</span>
          </div>
        {/if}

        <h3 class="history-title">历史快照（{calculations.length}）</h3>
        {#if calculations.length === 0}
          <p class="muted">尚未保存重算快照。</p>
        {:else}
          <ul class="history">
            {#each calculations as calc}
              <li>
                <span class="mono">{calc.rule_version}</span> · {fmtTime(calc.calculated_at)} ·
                利息 {fmtAmount(calc.total_interest)} / 违约金 {fmtAmount(calc.penalty_amount)} / 合计 {fmtAmount(calc.total_amount)} ·
                {calc.days_total} 天 / {calc.segments.length} 段
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if error}
      <div class="status error" role="alert">{error}</div>
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
    width: min(760px, 100%);
    max-height: 86vh;
    overflow-y: auto;
    background: var(--surface, #fff);
    color: var(--text-1, #0f172a);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
    padding: 20px 22px 22px;
    display: grid;
    gap: 14px;
  }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .title-wrap { display: flex; align-items: center; gap: 8px; }
  h2 { margin: 0; font-size: 16px; font-weight: 650; }
  h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
  .history-title { margin-top: 14px; }
  .hint { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2, #475569); }
  .muted { color: var(--text-2, #64748b); font-size: 12.5px; margin: 0; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .panel {
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
    padding: 12px 14px;
    background: var(--surface-2, #f8fafc);
  }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #e2e8f0); }
  th { font-weight: 600; color: var(--text-2, #475569); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.selected td { background: rgba(37, 99, 235, 0.06); }
  button.link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent, #2563eb); font: inherit; text-decoration: underline;
  }
  button.primary {
    display: inline-flex; align-items: center; gap: 6px;
    border: none; border-radius: 8px; cursor: pointer; font: inherit;
    background: var(--accent, #2563eb); color: #fff; padding: 6px 12px; font-size: 12.5px;
  }
  button.primary.sm { padding: 4px 10px; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    border: none; background: none; cursor: pointer; color: var(--text-2, #475569);
    border-radius: 6px; padding: 4px;
  }
  .status { border-radius: 10px; padding: 10px 12px; font-size: 13px; background: #f1f5f9; }
  .status.error { background: #fef2f2; color: #b91c1c; }
  .totals { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; font-size: 13px; align-items: baseline; }
  .history { margin: 0; padding-left: 18px; font-size: 12.5px; display: grid; gap: 4px; }
</style>
