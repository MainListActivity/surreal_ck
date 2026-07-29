<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowLeft,
    Building2,
    Clock3,
    RefreshCw,
    ShieldCheck,
  } from "@lucide/svelte";
  import type { QuotaApiBillingView } from "@surreal-ck/shared/native-quota";
  import { loadBillingQuota } from "../lib/quota/client";
  import {
    capacityPresentation,
    formatQuotaDate,
    quotaApiErrorMessage,
    syncPresentation,
  } from "../lib/quota/presentation";

  const POLL_INTERVAL_MS = 60_000;

  let {
    accountKey,
    onback,
    onopenworkspace,
  }: {
    accountKey: string;
    onback?: () => void;
    onopenworkspace?: (slug: string) => void;
  } = $props();

  let view = $state<QuotaApiBillingView | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state("");

  async function load(force: boolean) {
    if (force) refreshing = true;
    else if (!view) loading = true;
    error = "";
    try {
      view = await loadBillingQuota(accountKey, force);
    } catch (cause) {
      error = quotaApiErrorMessage(cause);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    void load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  });
</script>

<div class="billing-page">
  <header class="topbar">
    <button type="button" class="back" onclick={() => onback?.()}>
      <ArrowLeft size={16} />返回工作区
    </button>
    <div class="brand"><Building2 size={17} /><strong>计费账户配额</strong></div>
    <button type="button" class="refresh" disabled={refreshing} onclick={() => void load(true)}>
      <span class:spinning={refreshing}><RefreshCw size={14} /></span>刷新
    </button>
  </header>

  <main>
    {#if error}
      <section class="empty error">
        <h1>无法读取计费账户</h1>
        <p>{error}</p>
        <button type="button" onclick={() => void load(false)}>重试</button>
      </section>
    {:else if loading}
      <section class="empty"><p>正在组合订阅与原生用量…</p></section>
    {:else if view}
      <section class="hero">
        <span class="eyebrow"><ShieldCheck size={13} />Billing capability</span>
        <h1>{view.billing_account.name}</h1>
        <p>{view.billing_account.account_key} · 当前账户负责 {view.workspaces.length} 个工作区的资源权益</p>
        <small><Clock3 size={12} />汇总于 {formatQuotaDate(view.observed_at)}</small>
      </section>

      <section class="allocation">
        <div class="section-head">
          <div>
            <h2>工作区分配</h2>
            <p>仅展示计划、订阅状态和聚合利用率；未加入的工作区不会泄露物理表名或逐表记录数。</p>
          </div>
        </div>

        <div class="table" role="table" aria-label="计费账户工作区分配">
          <div class="table-head" role="row">
            <span>工作区</span><span>计划与订阅</span><span>容量</span><span>同步</span><span>观测</span>
          </div>
          {#each view.workspaces as item (item.workspace.id)}
            {@const capacity = capacityPresentation(item.utilization.capacity)}
            {@const sync = syncPresentation(item.statuses.sync)}
            <button
              type="button"
              class="table-row"
              role="row"
              onclick={() => onopenworkspace?.(item.workspace.slug)}
            >
              <div>
                <strong>{item.workspace.name}</strong>
                <small>{item.workspace.slug}</small>
              </div>
              <div>
                <strong>{item.plan_name ?? "尚未分配"}</strong>
                <small>
                  {item.subscription_status ?? "状态未知"}
                  {#if item.subscription?.grace_until} · 宽限至 {formatQuotaDate(item.subscription.grace_until)}
                  {:else if item.subscription?.cancel_at} · 取消于 {formatQuotaDate(item.subscription.cancel_at)}
                  {:else if item.subscription?.current_period_end} · 周期至 {formatQuotaDate(item.subscription.current_period_end)}
                  {/if}
                </small>
              </div>
              <div>
                <strong data-tone={capacity.tone}>{capacity.label}</strong>
                <small>{item.utilization.highest_percent === null ? "暂不可确认" : `${item.utilization.highest_percent}%`}</small>
              </div>
              <div>
                <strong data-tone={sync.tone}>{sync.label}</strong>
                <small>{item.statuses.ledger ?? "账本未知"}</small>
              </div>
              <div>
                <strong>{item.utilization.usage_trusted ? "可信" : "未知"}</strong>
                <small>{item.utilization.stale ? "已陈旧" : "最近观测"}</small>
              </div>
            </button>
          {:else}
            <div class="no-rows">当前账户没有 active 或 scheduled 工作区分配。</div>
          {/each}
        </div>
      </section>
    {/if}
  </main>
</div>

<style>
  .billing-page { min-height: 100vh; background: var(--bg); color: var(--text-1); }
  .topbar {
    position: sticky;
    z-index: 10;
    top: 0;
    display: grid;
    height: 58px;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: rgba(251, 250, 245, .92);
    backdrop-filter: blur(14px);
  }
  button { font: inherit; }
  .back, .refresh {
    display: inline-flex;
    width: max-content;
    height: 34px;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }
  .refresh { justify-self: end; }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--primary); font-size: 13px; }
  main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 44px 0 70px; }
  .hero { padding: 10px 2px 30px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 6px; color: var(--primary); font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  h1, h2, p { margin: 0; }
  h1 { margin-top: 8px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.035em; }
  .hero p { margin-top: 8px; color: var(--text-2); font-size: 13px; }
  .hero small { display: flex; align-items: center; gap: 5px; margin-top: 14px; color: var(--text-3); font-size: 11px; }
  .allocation { overflow: hidden; border: 1px solid var(--border); border-radius: 17px; background: var(--surface-2); box-shadow: 0 16px 42px -34px rgba(34, 30, 23, .5); }
  .section-head { padding: 20px 22px; border-bottom: 1px solid var(--border); }
  .section-head h2 { font-size: 16px; }
  .section-head p { margin-top: 5px; color: var(--text-3); font-size: 11px; }
  .table-head, .table-row {
    display: grid;
    grid-template-columns: 1.25fr 1fr .8fr .8fr .65fr;
    gap: 18px;
    align-items: center;
  }
  .table-head { padding: 10px 18px; background: var(--surface); color: var(--text-3); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .table-row {
    width: 100%;
    padding: 15px 18px;
    border: 0;
    border-top: 1px solid var(--border);
    background: #fff;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .table-row:hover { background: #f9fbf6; }
  .table-row div { display: grid; min-width: 0; gap: 4px; }
  .table-row strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .table-row small { color: var(--text-3); font-size: 10px; }
  [data-tone="positive"] { color: var(--success); }
  [data-tone="warning"] { color: var(--warning); }
  [data-tone="critical"] { color: #b63f33; }
  [data-tone="unknown"] { color: var(--text-3); }
  .no-rows, .empty { padding: 48px 24px; color: var(--text-3); text-align: center; }
  .empty { display: grid; min-height: 50vh; place-content: center; gap: 10px; }
  .empty button { justify-self: center; padding: 8px 14px; border: 0; border-radius: 8px; background: var(--primary); color: #fff; cursor: pointer; }
  .empty.error h1 { color: var(--text-1); font-size: 22px; }
  .spinning { display: inline-flex; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 780px) {
    .table-head { display: none; }
    .table-row { grid-template-columns: 1fr 1fr; }
    .topbar { padding: 0 12px; }
    .brand strong { display: none; }
  }
</style>
