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
  <div class="tab-bar" role="tablist">
    {#each tabs as tab}
      <button
        role="tab"
        aria-selected={activeTab === tab.id}
        class="tab-btn"
        class:active={activeTab === tab.id}
        onclick={() => handleTabClick(tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div class="panel-body">
    {#if activeTab === "activity"}
      <ul class="activity-list">
        {#each MOCK_ACTIVITY_ENTRIES as entry (entry.id)}
          <li class="activity-item">
            <Avatar name={entry.actor} size={28} />
            <div class="activity-content">
              <p class="activity-desc">
                <span class="actor">{entry.actor}</span>
                {entry.action}
              </p>
              <time class="activity-time">{formatRelativeTime(entry.timestamp)}</time>
            </div>
          </li>
        {/each}
      </ul>
    {:else if activeTab === "overview"}
      <div class="overview-section">
        <div class="stat-card">
          <span class="stat-label">工作簿总数</span>
          <span class="stat-value">
            {#if workbookCount === null}
              <span class="loading">…</span>
            {:else}
              {workbookCount}
            {/if}
          </span>
        </div>

        <div class="chart-section">
          <p class="chart-title">本周新增记录</p>
          <div class="bar-chart" aria-label="本周新增记录趋势图">
            {#each MOCK_CHART_BARS as bar}
              <div class="bar-col">
                <div
                  class="bar"
                  style={`height:${Math.round((bar.value / maxBarValue) * 80)}px`}
                  title={`${bar.label}: ${bar.value}`}
                ></div>
                <span class="bar-label">{bar.label}</span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {:else if activeTab === "tasks"}
      <div class="tasks-stub">
        <svg
          class="stub-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <p class="stub-title">虚拟办公室功能即将上线</p>
        <p class="stub-desc">任务由 AI 员工自动处理，敬请期待。</p>
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

  /* segment control tab bar */
  .tab-bar {
    display: flex;
    height: 44px;
    flex-shrink: 0;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .tab-btn {
    flex: 1;
    height: 30px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }

  .tab-btn:hover:not(.active) {
    background: var(--surface-2, rgba(0 0 0 / .04));
  }

  .tab-btn.active {
    background: var(--accent, #5B78F6);
    color: #fff;
  }

  /* scrollable body */
  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 0;
  }

  /* activity list */
  .activity-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .activity-item:last-child {
    border-bottom: none;
  }

  .activity-content {
    flex: 1;
    min-width: 0;
  }

  .activity-desc {
    margin: 0 0 2px;
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.5;
    word-break: break-all;
  }

  .actor {
    font-weight: 600;
    color: var(--text-1);
    margin-right: 2px;
  }

  .activity-time {
    font-size: 11px;
    color: var(--text-3);
  }

  /* overview section */
  .overview-section {
    padding: 0 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px;
    border-radius: 10px;
    background: var(--surface-2, rgba(0 0 0 / .04));
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-3);
    font-weight: 500;
  }

  .stat-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1;
  }

  .loading {
    font-size: 18px;
    color: var(--text-3);
  }

  .chart-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chart-title {
    margin: 0;
    font-size: 11px;
    color: var(--text-3);
    font-weight: 500;
  }

  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 96px;
  }

  .bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    height: 96px;
  }

  .bar {
    width: 100%;
    border-radius: 3px 3px 0 0;
    background: var(--accent, #5B78F6);
    opacity: 0.7;
    min-height: 4px;
    transition: opacity 0.15s;
  }

  .bar:hover {
    opacity: 1;
  }

  .bar-label {
    font-size: 9px;
    color: var(--text-3);
    white-space: nowrap;
  }

  /* tasks stub */
  .tasks-stub {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    text-align: center;
  }

  .stub-icon {
    width: 40px;
    height: 40px;
    color: var(--text-3);
    opacity: 0.5;
  }

  .stub-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }

  .stub-desc {
    margin: 0;
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.5;
  }
</style>
