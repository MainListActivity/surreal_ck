<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Avatar from "./Avatar.svelte";
  import RiskNotificationInbox from "./RiskNotificationInbox.svelte";
  import { loadRiskNotifications, type RiskNotification } from "$lib/risk-notifications";
  import {
    type ActivityTab,
    type ChartBar,
    countWorkbooks,
    loadDailyActivityTrend,
  } from "$lib/activity-panel";
  import { activityFeed } from "$lib/activity-feed.svelte";
  import { activityRelativeTime } from "$lib/activity-feed";
  import { getSurreal } from "$lib/surreal";

  let {
    onopenrecord,
    onaskai,
  }: {
    onopenrecord?: (target: { workbookId: string; sheetId: string; recordId: string }) => void;
    onaskai?: (notification: RiskNotification) => void;
  } = $props();

  let activeTab = $state<ActivityTab>("activity");

  const tabs: { id: ActivityTab; label: string }[] = [
    { id: "activity", label: "动态" },
    { id: "overview", label: "数据概览" },
    { id: "notifications", label: "提醒" },
  ];

  let workbookCount = $state<number | null>(null);
  let trendBars = $state<ChartBar[]>([]);
  let notificationCount = $state(0);
  let stopNotificationLive: (() => void) | null = null;

  const maxBarValue = $derived(Math.max(...trendBars.map((b) => b.value), 1));

  onMount(() => {
    void activityFeed.start();
    void refreshNotificationCount();
    void getSurreal().liveTable("user_notification", () => void refreshNotificationCount())
      .then((stop) => { stopNotificationLive = stop; })
      .catch(() => undefined);
    if (activeTab === "overview") loadOverview();
  });

  onDestroy(() => {
    activityFeed.stop();
    stopNotificationLive?.();
  });

  async function refreshNotificationCount() {
    try {
      notificationCount = (await loadRiskNotifications(getSurreal())).length;
    } catch {
      notificationCount = 0;
    }
  }

  async function loadOverview() {
    if (workbookCount !== null) return;
    const conn = getSurreal();
    try {
      workbookCount = await countWorkbooks(conn);
    } catch {
      workbookCount = 0;
    }
    try {
      trendBars = await loadDailyActivityTrend(conn);
    } catch {
      trendBars = [];
    }
  }

  function handleTabClick(tab: ActivityTab) {
    activeTab = tab;
    if (tab === "overview") loadOverview();
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
        {#if tab.id === "notifications" && notificationCount > 0}
          <span class="notification-dot" aria-label={`${notificationCount} 条未处理提醒`}></span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="panel-body" role="tabpanel">
    {#if activeTab === "activity"}
      {#if activityFeed.loading && activityFeed.items.length === 0}
        <div class="feed-state">加载中…</div>
      {:else if activityFeed.items.length === 0}
        <div class="feed-state">暂无动态</div>
      {:else}
        {#each activityFeed.items as item (item.id)}
          {@const actor = activityFeed.actorName(item)}
          <div class="activity-item" role="article">
            <Avatar name={actor} size={26} />
            <div class="activity-content">
              <div class="activity-text">
                <strong>{actor}</strong>{" "}{item.action}
              </div>
              <div class="activity-time">{activityRelativeTime(item)}</div>
            </div>
          </div>
        {/each}
      {/if}
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
          <span class="insight-card-title">近 7 天动态</span>
        </div>
        <div class="insight-mini-chart" aria-label="近 7 天动态趋势图" aria-hidden="true">
          {#each trendBars as bar}
            <div
              class="mini-bar"
              style={`height:${Math.round((bar.value / maxBarValue) * 100)}%`}
              title={`${bar.label}: ${bar.value}`}
            ></div>
          {/each}
        </div>
        <div class="chart-labels" aria-hidden="true">
          {#each trendBars as bar}
            <span>{bar.label.slice(1)}</span>
          {/each}
        </div>
      </div>
    {:else if activeTab === "notifications"}
      <RiskNotificationInbox {onopenrecord} {onaskai} />
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
    position: relative;
  }

  .notification-dot { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; border-radius: 999px; background: var(--error); }

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

  /* activity feed loading / empty state */
  .feed-state {
    padding: 32px 12px;
    font-size: 12px;
    color: var(--text-3);
    text-align: center;
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
    font-weight: 600;
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

</style>
