<script lang="ts">
  import { onMount } from "svelte";
  import {
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    Clock3,
    Database,
    Gauge,
    RefreshCw,
    ShieldAlert,
  } from "@lucide/svelte";
  import type {
    QuotaApiCustomerView,
    QuotaApiOperatorView,
    QuotaApiWorkspaceView,
  } from "@surreal-ck/shared/native-quota";
  import { loadWorkspaceQuota } from "../../lib/quota/client";
  import {
    formatQuotaCount,
    formatQuotaDate,
    quotaApiErrorMessage,
    statusCards,
  } from "../../lib/quota/presentation";

  const POLL_INTERVAL_MS = 60_000;

  let { slug }: { slug: string } = $props();

  let view = $state<QuotaApiWorkspaceView | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state("");
  let loadedSlug = $state("");

  const detailed = $derived<
    QuotaApiCustomerView | QuotaApiOperatorView | null
  >(
    view?.view === "workspace_admin" || view?.view === "operator"
      ? view
      : null,
  );
  const cards = $derived(detailed ? statusCards(detailed.statuses) : []);
  const pendingChange = $derived(
    detailed?.desired
      && detailed.applied
      && (
        detailed.desired.entitlement_revision
          !== detailed.applied.entitlement_revision
        || detailed.desired.plan_key !== detailed.applied.plan_key
      )
      ? detailed.desired
      : null,
  );

  async function load(force: boolean) {
    if (!slug || (force && refreshing)) return;
    if (force) refreshing = true;
    else if (!view) loading = true;
    error = "";
    try {
      view = await loadWorkspaceQuota(slug, force);
      loadedSlug = slug;
    } catch (cause) {
      error = quotaApiErrorMessage(cause);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function utilizationWidth(percent: number | null): number {
    return percent === null ? 0 : Math.max(0, Math.min(percent, 100));
  }

  onMount(() => {
    void load(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  $effect(() => {
    if (slug && slug !== loadedSlug && !loading) void load(false);
  });
</script>

<section class="quota-section" aria-label="资源配额">
  <header class="quota-head">
    <div>
      <span class="eyebrow"><Gauge size={13} />原生资源配额</span>
      <h2>套餐与用量</h2>
      <p>额度由数据库原生 enforcement 判断；这里的摘要只用于解释和运营。</p>
    </div>
    <button
      type="button"
      class="refresh-button"
      disabled={loading || refreshing}
      onclick={() => void load(true)}
    >
      <span class:spinning={refreshing}><RefreshCw size={14} /></span>
      {refreshing ? "读取 INFO…" : "刷新用量"}
    </button>
  </header>

  {#if error}
    <div class="notice error" role="alert">
      <AlertTriangle size={17} />
      <div><strong>配额摘要加载失败</strong><span>{error}</span></div>
    </div>
  {:else if loading}
    <div class="loading-grid" aria-label="正在加载配额">
      {#each [1, 2, 3, 4] as item (item)}
        <span></span>
      {/each}
    </div>
  {:else if view?.view === "participant"}
    <div class="participant-card">
      <ShieldAlert size={22} />
      <div>
        <strong>配额详情由工作区管理员管理</strong>
        <p>普通成员不会看到套餐、全表记录数或其它数据表名称。操作因容量被拒时，你的草稿会保留，请减少当前操作或联系管理员。</p>
      </div>
    </div>
  {:else if view?.view === "billing_admin"}
    <div class="billing-summary">
      <div>
        <span>当前计划</span>
        <strong>{view.plan_name ?? "尚未分配"}</strong>
        <small>{view.subscription_status ?? "状态未知"}</small>
      </div>
      <div>
        <span>聚合利用率</span>
        <strong>{view.utilization.highest_percent === null ? "暂不可确认" : `${view.utilization.highest_percent}%`}</strong>
        <small>不展示物理表名和逐表用量</small>
      </div>
      {#if view.utilization.stale || !view.utilization.usage_trusted}
        <div class="notice warning">
          <Clock3 size={16} />
          <span>聚合用量陈旧或不可信，不能将未知视作 0。</span>
        </div>
      {/if}
    </div>
  {:else if detailed}
    <div class="plan-row">
      <article class="plan-card current">
        <div class="plan-icon"><Database size={19} /></div>
        <div>
          <span>当前已应用</span>
          <h3>{detailed.applied?.plan_name ?? "尚未应用计划"}</h3>
          {#if detailed.applied}
            <p>{detailed.applied.source} · revision {detailed.applied.plan_revision}</p>
          {:else}
            <p>等待资源权益和 native policy 物化</p>
          {/if}
        </div>
        {#if detailed.applied}
          <span class="plan-check"><CheckCircle2 size={17} /></span>
        {/if}
      </article>

      {#if pendingChange}
        <span class="plan-arrow"><ArrowRight size={18} /></span>
        <article class="plan-card pending">
          <div>
            <span>待应用变更</span>
            <h3>{pendingChange.plan_name}</h3>
            <p>计划于 {formatQuotaDate(pendingChange.effective_at)} 生效</p>
          </div>
          <Clock3 size={17} />
        </article>
      {/if}
    </div>

    {#if detailed.billing_account}
      <a
        class="billing-link"
        href={`/billing/${encodeURIComponent(detailed.billing_account.account_key)}/quota`}
      >
        <span>
          付款账户：<strong>{detailed.billing_account.name}</strong>
          · {detailed.billing_account.subscription.status}
        </span>
        <ArrowRight size={14} />
      </a>
    {/if}

    {#if detailed.stale || !detailed.usage_trusted}
      <div class="notice warning" role="status">
        <AlertTriangle size={17} />
        <div>
          <strong>{detailed.stale ? "用量观测已陈旧" : "账本用量暂不可信"}</strong>
          <span>未知值不会显示为 0，也不会用于乐观允许写入。</span>
        </div>
      </div>
    {/if}

    <div class="status-grid">
      {#each cards as card (card.key)}
        <article class="status-card" data-tone={card.tone}>
          <span>{card.title}</span>
          <strong>{card.label}</strong>
          <p>{card.description}</p>
        </article>
      {/each}
    </div>

    <div class="usage-head">
      <div>
        <h3>资源用量</h3>
        <p>
          原生 INFO 观测于 {formatQuotaDate(detailed.observed_at)}
          {#if detailed.cache_age_ms !== null} · 缓存 {Math.round(detailed.cache_age_ms / 1000)} 秒{/if}
        </p>
      </div>
      <span class:trusted={detailed.usage_trusted}>
        {detailed.usage_trusted ? "账本可信" : "账本未知"}
      </span>
    </div>

    <div class="resource-list">
      {#each detailed.resources as resource (resource.key)}
        <article class="resource-card">
          <div class="resource-title">
            <div>
              <span class="resource-kind">{resource.resource}</span>
              <strong>{resource.label}</strong>
              <p>{resource.description ?? resource.selector.description}</p>
            </div>
            <div class="resource-count">
              <strong>{formatQuotaCount(resource.usage.used)}</strong>
              <span>
                / {resource.usage.kind === "unlimited" ? "不限" : formatQuotaCount(resource.usage.limit)}
              </span>
            </div>
          </div>
          <div
            class="meter"
            class:unknown={resource.usage.utilization_percent === null}
            class:over={resource.usage.over_limit}
          >
            <span style={`width: ${utilizationWidth(resource.usage.utilization_percent)}%`}></span>
          </div>
          <div class="resource-meta">
            <span>
              {#if resource.usage.kind === "finite"}
                剩余 {formatQuotaCount(resource.usage.remaining)}
              {:else}
                无固定上限
              {/if}
            </span>
            {#if resource.selector.kind === "regex" && resource.selector.pattern}
              <code>{resource.selector.pattern}</code>
              {#if resource.selector.matched_tables?.length}
                <span>命中 {resource.selector.matched_tables.join("、")}</span>
              {/if}
            {:else if resource.selector.kind === "exact" && resource.selector.table}
              <code>{resource.selector.table}</code>
            {/if}
          </div>
        </article>
      {:else}
        <div class="empty-usage">当前尚无可展示的 applied 配额规则。</div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .quota-section {
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface-2);
    box-shadow: 0 14px 36px -30px rgba(34, 30, 23, .35);
    overflow: hidden;
  }

  .quota-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding: 24px 26px 20px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(231, 240, 228, .85), rgba(255, 255, 255, .9));
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    color: var(--primary);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  h2, h3, p { margin: 0; }
  h2 { font-size: 20px; }
  .quota-head p, .usage-head p { margin-top: 5px; color: var(--text-3); font-size: 12px; }

  .refresh-button {
    display: inline-flex;
    height: 36px;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    border: 1px solid var(--border-dark);
    border-radius: 10px;
    background: rgba(255, 255, 255, .75);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }

  .refresh-button:disabled { opacity: .55; cursor: default; }
  .spinning { display: inline-flex; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-grid, .status-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    padding: 22px 26px;
  }
  .loading-grid span { height: 102px; border-radius: 13px; background: var(--soft); animation: pulse 1.2s ease-in-out infinite alternate; }
  @keyframes pulse { to { opacity: .45; } }

  .notice, .participant-card {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    margin: 18px 26px 0;
    padding: 13px 14px;
    border: 1px solid rgba(204, 107, 58, .24);
    border-radius: 12px;
    background: #fff8ed;
    color: #8b4a2a;
    font-size: 12px;
  }
  .notice > div, .participant-card > div { display: grid; gap: 3px; }
  .notice span, .participant-card p { line-height: 1.5; }
  .notice.error { border-color: rgba(184, 55, 55, .22); background: #fff2f0; color: #9b3030; }
  .participant-card { margin-bottom: 20px; }
  .participant-card strong { color: var(--text-1); }
  .participant-card p { color: var(--text-2); }

  .plan-row {
    display: flex;
    align-items: stretch;
    gap: 12px;
    padding: 22px 26px 0;
  }
  .plan-card {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 13px;
    padding: 17px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
  }
  .plan-card.current { border-color: rgba(47, 122, 76, .28); background: var(--success-bg); }
  .plan-card.pending { border-style: dashed; }
  .plan-icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 11px; background: #fff; color: var(--primary); }
  .plan-card span { color: var(--text-3); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .plan-card h3 { margin-top: 3px; font-size: 17px; }
  .plan-card p { margin-top: 3px; color: var(--text-2); font-size: 11px; }
  .plan-check { margin-left: auto; color: var(--success); }
  .plan-arrow { align-self: center; color: var(--text-3); }
  .billing-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 26px 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 11px;
    text-decoration: none;
  }
  .billing-link:hover { border-color: var(--primary); color: var(--primary); }

  .status-card {
    min-height: 104px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 13px;
    background: var(--surface);
  }
  .status-card > span { color: var(--text-3); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .status-card strong { display: block; margin-top: 7px; font-size: 14px; }
  .status-card p { margin-top: 6px; color: var(--text-3); font-size: 11px; line-height: 1.45; }
  .status-card[data-tone="positive"] strong { color: var(--success); }
  .status-card[data-tone="warning"] strong { color: var(--warning); }
  .status-card[data-tone="critical"] strong { color: #b63f33; }
  .status-card[data-tone="unknown"] strong { color: var(--text-3); }

  .usage-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 4px 26px 12px;
  }
  .usage-head h3 { font-size: 14px; }
  .usage-head > span { padding: 4px 8px; border-radius: 999px; background: var(--soft); color: var(--text-3); font-size: 10px; font-weight: 700; }
  .usage-head > span.trusted { background: var(--success-bg); color: var(--success); }

  .resource-list { display: grid; gap: 9px; padding: 0 26px 26px; }
  .resource-card { padding: 15px 16px; border: 1px solid var(--border); border-radius: 13px; background: #fff; }
  .resource-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .resource-title > div:first-child { min-width: 0; }
  .resource-kind { margin-right: 7px; padding: 2px 5px; border-radius: 5px; background: var(--primary-light); color: var(--primary); font-size: 9px; font-weight: 750; text-transform: uppercase; }
  .resource-title strong { font-size: 13px; }
  .resource-title p { margin-top: 5px; color: var(--text-3); font-size: 11px; }
  .resource-count { flex-shrink: 0; color: var(--text-3); font-size: 11px; }
  .resource-count strong { color: var(--text-1); font-size: 18px; font-variant-numeric: tabular-nums; }

  .meter { height: 7px; margin-top: 13px; overflow: hidden; border-radius: 999px; background: var(--soft); }
  .meter span { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
  .meter.over span { background: #b63f33; }
  .meter.unknown { background: repeating-linear-gradient(135deg, var(--soft), var(--soft) 5px, #e2dccf 5px, #e2dccf 10px); }

  .resource-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px 12px; margin-top: 8px; color: var(--text-3); font-size: 10px; }
  .resource-meta code { max-width: 100%; overflow: hidden; padding: 2px 5px; border-radius: 4px; background: var(--soft); color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; }
  .empty-usage { padding: 24px; border: 1px dashed var(--border-dark); border-radius: 13px; color: var(--text-3); font-size: 12px; text-align: center; }

  .billing-summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 22px 26px; }
  .billing-summary > div:not(.notice) { display: grid; gap: 5px; padding: 16px; border: 1px solid var(--border); border-radius: 13px; }
  .billing-summary span, .billing-summary small { color: var(--text-3); font-size: 11px; }
  .billing-summary strong { font-size: 17px; }
  .billing-summary .notice { grid-column: 1 / -1; margin: 0; }

  @media (max-width: 900px) {
    .status-grid, .loading-grid { grid-template-columns: repeat(2, 1fr); }
    .plan-row { flex-direction: column; }
    .plan-arrow { transform: rotate(90deg); }
  }
  @media (max-width: 620px) {
    .quota-head { flex-direction: column; }
    .status-grid, .loading-grid, .billing-summary { grid-template-columns: 1fr; }
  }
</style>
