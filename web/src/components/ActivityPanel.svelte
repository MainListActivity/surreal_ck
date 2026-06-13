<script lang="ts">
  import { onMount } from "svelte";
  import Avatar from "./Avatar.svelte";
  import {
    type ActivityTab,
    formatRelativeTime,
    countWorkbooks,
    MOCK_ACTIVITY_ENTRIES,
    MOCK_CHART_BARS,
  } from "$lib/activity-panel";
  import { getSurreal } from "$lib/surreal";

  let activeTab = $state<ActivityTab>("activity");

  const tabs: { id: ActivityTab; label: string }[] = [
    { id: "activity", label: "动态" },
    { id: "overview", label: "数据概览" },
    { id: "tasks", label: "任务" },
  ];

  let workbookCount = $state<number | null>(null);

  const maxBarValue = $derived(Math.max(...MOCK_CHART_BARS.map((b) => b.value), 1));

  onMount(() => {
    if (activeTab === "overview") loadWorkbookCount();
  });

  async function loadWorkbookCount() {
    if (workbookCount !== null) return;
    try {
      const conn = getSurreal();
      workbookCount = await countWorkbooks(conn);
    } catch {
      workbookCount = 0;
    }
  }

  function handleTabClick(tab: ActivityTab) {
    activeTab = tab;
    if (tab === "overview") loadWorkbookCount();
  }
</script>

<aside class="activity-panel" aria-label="工作区动态">
  <div class="panel-tabs" role="tablist">
    {#each tabs as tab}
      <button
        role="tab"
        aria-selected={activeTab === tab.id}
        class="panel-tab"
        class:active={activeTab === tab.id}
        onclick={() => handleTabClick(tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div class="panel-body" role="tabpanel">
    {#if activeTab === "activity"}
      {#each MOCK_ACTIVITY_ENTRIES as entry (entry.id)}
        <div class="activity-item" role="article">
          <Avatar name={entry.actor} size={26} />
          <div class="activity-content">
            <div class="activity-text">
              <strong>{entry.actor}</strong>{" "}{entry.action}
            </div>
            <div class="activity-time">{formatRelativeTime(entry.timestamp)}</div>
          </div>
        </div>
      {/each}
    {:else if activeTab === "overview"}
      <div class="insight-card">
        <div class="insight-card-header">
          <span class="insight-card-title">工作簿总数</span>
        </div>
        <div class="insight-stat" aria-label="工作簿总数">
          {#if workbookCount === null}
            <span class="loading">…</span>
          {:else}
            {workbookCount}
          {/if}
        </div>
        <div class="insight-card-header" style="margin-top: 16px;">
          <span class="insight-card-title">本周新增记录</span>
        </div>
        <div class="insight-mini-chart" aria-label="本周新增记录趋势图" aria-hidden="true">
          {#each MOCK_CHART_BARS as bar}
            <div
              class="mini-bar"
              style={`height:${Math.round((bar.value / maxBarValue) * 100)}%`}
              title={`${bar.label}: ${bar.value}`}
            ></div>
          {/each}
        </div>
        <div class="chart-labels" aria-hidden="true">
          {#each MOCK_CHART_BARS as bar}
            <span>{bar.label.slice(1)}</span>
          {/each}
        </div>
      </div>
    {:else if activeTab === "tasks"}
      <div class="empty-state">
        <svg
          class="empty-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <p class="empty-title">虚拟办公室功能即将上线</p>
        <p class="empty-desc">任务由 AI 员工自动处理，敬请期待。</p>
      </div>
    {/if}
  </div>
</aside>

<style>
  .activity-panel {
    display: flex;
    width: 280px;
    height: 100vh;
    flex-shrink: 0;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  /* tab bar — prototype style: tabs sit in a row with padding, active gets elevated bg */
  .panel-tabs {
    display: flex;
    gap: 4px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .panel-tab {
    flex: 1;
    padding: 5px 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    cursor: pointer;
    border: none;
    background: none;
    border-radius: 6px;
    transition: background 0.12s, color 0.12s;
    white-space: nowrap;
    text-align: center;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .panel-tab:hover:not(.active) {
    background: var(--soft, rgba(0 0 0 / .04));
    color: var(--text-2);
  }

  .panel-tab.active {
    background: var(--soft, rgba(0 0 0 / .06));
    color: var(--text-1);
    font-weight: 600;
  }

  /* scrollable body */
  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  /* activity feed items — hover card style matching prototype */
  .activity-item {
    display: flex;
    gap: 9px;
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }

  .activity-item:hover {
    background: var(--soft, rgba(0 0 0 / .04));
  }

  .activity-content {
    flex: 1;
    min-width: 0;
  }

  .activity-text {
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.45;
    margin-bottom: 2px;
    word-break: break-all;
  }

  .activity-text strong {
    color: var(--text-1);
    font-weight: 500;
  }

  .activity-time {
    font-size: 11px;
    color: var(--text-3);
  }

  /* overview: insight card */
  .insight-card {
    background: var(--soft, rgba(0 0 0 / .04));
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
  }

  .insight-card-header {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
  }

  .insight-card-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }

  .insight-stat {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.5px;
    margin-bottom: 4px;
    font-variant-numeric: tabular-nums;
  }

  .loading {
    font-size: 20px;
    color: var(--text-3);
  }

  .insight-mini-chart {
    height: 48px;
    display: flex;
    align-items: flex-end;
    gap: 3px;
    margin-top: 8px;
  }

  .mini-bar {
    flex: 1;
    background: var(--primary, #2563eb);
    opacity: 0.45;
    border-radius: 2px 2px 0 0;
    min-height: 3px;
    transition: opacity 0.15s;
  }

  .mini-bar:hover {
    opacity: 0.85;
  }

  .chart-labels {
    display: flex;
    gap: 3px;
    margin-top: 4px;
  }

  .chart-labels span {
    flex: 1;
    font-size: 9px;
    color: var(--text-3);
    text-align: center;
  }

  /* tasks stub */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 16px;
    text-align: center;
  }

  .empty-icon {
    width: 36px;
    height: 36px;
    color: var(--text-3);
    opacity: 0.4;
  }

  .empty-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }

  .empty-desc {
    margin: 0;
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.5;
  }
</style>
