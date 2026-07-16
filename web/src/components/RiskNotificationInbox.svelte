<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Bell, Check, ExternalLink, Sparkles } from "@lucide/svelte";
  import { getSurreal } from "$lib/surreal";
  import {
    loadClaimsReminderSettings,
    loadRiskNotifications,
    resolveRiskNotification,
    resolveRiskNotificationTarget,
    setClaimsReminderEnabled,
    type ClaimsReminderSetting,
    type RiskNotification,
  } from "$lib/risk-notifications";

  let {
    onopenrecord,
    onaskai,
  }: {
    onopenrecord?: (target: { workbookId: string; sheetId: string; recordId: string }) => void;
    onaskai?: (notification: RiskNotification) => void;
  } = $props();

  let notifications = $state<RiskNotification[]>([]);
  let settings = $state<ClaimsReminderSetting[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  let unsubscribe: (() => void) | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      [notifications, settings] = await Promise.all([
        loadRiskNotifications(getSurreal()),
        loadClaimsReminderSettings(getSurreal()),
      ]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "提醒加载失败";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    void getSurreal().liveTable("user_notification", () => void load()).then((stop) => {
      unsubscribe = stop;
    }).catch(() => undefined);
  });

  onDestroy(() => unsubscribe?.());

  async function toggleSetting(setting: ClaimsReminderSetting) {
    await setClaimsReminderEnabled(getSurreal(), setting.workbookId, !setting.enabled);
    settings = settings.map((item) => item.workbookId === setting.workbookId
      ? { ...item, enabled: !item.enabled }
      : item);
  }

  async function openRecord(notification: RiskNotification) {
    const target = await resolveRiskNotificationTarget(getSurreal(), {
      workbookId: notification.workbookId,
      recordId: notification.recordId,
    });
    if (target) onopenrecord?.(target);
  }

  async function markResolved(notification: RiskNotification) {
    const resolution = window.prompt("填写处理结果");
    if (!resolution?.trim()) return;
    await resolveRiskNotification(getSurreal(), notification.id, resolution);
    notifications = notifications.filter((item) => item.id !== notification.id);
  }

  function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
  }
</script>

<div class="inbox">
  {#if settings.length > 0}
    <section class="settings" aria-label="每日提醒设置">
      <strong>每日检查</strong>
      {#each settings as setting (setting.workbookId)}
        <label>
          <span title={setting.workbookName}>{setting.workbookName}</span>
          <input
            type="checkbox"
            checked={setting.enabled}
            onchange={() => void toggleSetting(setting)}
          />
        </label>
      {/each}
    </section>
  {/if}

  {#if loading && notifications.length === 0}
    <div class="state">加载提醒…</div>
  {:else if error}
    <div class="state error">{error}</div>
  {:else if notifications.length === 0}
    <div class="state"><Bell size={20} /><span>暂无待处理风险提醒</span></div>
  {:else}
    {#each notifications as notification (notification.id)}
      <article class:urgent={notification.severity === "urgent"}>
        <button class="summary" onclick={() => (expanded = expanded === notification.id ? null : notification.id)}>
          <span class="severity" aria-hidden="true"></span>
          <span><strong>{notification.title}</strong><small>{notification.workbookName}</small></span>
        </button>
        {#if expanded === notification.id}
          <div class="detail">
            <p>{notification.body}</p>
            <dl>
              {#each Object.entries(notification.matchedFields) as [key, value]}
                <div><dt>{key}</dt><dd>{String(value)}</dd></div>
              {/each}
              <div><dt>命中规则</dt><dd>{notification.rule}</dd></div>
              <div><dt>检查时间</dt><dd>{formatTime(notification.checkedAt)}</dd></div>
            </dl>
            <div class="actions">
              <button onclick={() => void openRecord(notification)}><ExternalLink size={12} />打开记录</button>
              <button onclick={() => onaskai?.(notification)}><Sparkles size={12} />继续询问 AI</button>
              <button onclick={() => void markResolved(notification)}><Check size={12} />已处理</button>
            </div>
          </div>
        {/if}
      </article>
    {/each}
  {/if}
</div>

<style>
  .inbox { display: flex; flex-direction: column; gap: 8px; }
  .settings { display: flex; flex-direction: column; gap: 6px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--soft); font-size: 11px; }
  .settings label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-2); }
  .settings label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 28px 8px; color: var(--text-3); font-size: 12px; text-align: center; }
  .state.error { color: var(--error); }
  article { overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
  article.urgent { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); }
  .summary { display: grid; width: 100%; grid-template-columns: 4px 1fr; gap: 8px; padding: 9px; border: 0; background: transparent; color: var(--text-1); text-align: left; cursor: pointer; }
  .summary .severity { border-radius: 99px; background: var(--warning); }
  .urgent .summary .severity { background: var(--error); }
  .summary span:last-child { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .summary strong { font-size: 12px; }
  .summary small { overflow: hidden; color: var(--text-3); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .detail { padding: 0 10px 10px 22px; color: var(--text-2); font-size: 11px; }
  .detail p { margin: 0 0 8px; line-height: 1.5; }
  dl { display: flex; flex-direction: column; gap: 4px; margin: 0 0 9px; }
  dl div { display: grid; grid-template-columns: 58px 1fr; gap: 6px; }
  dt { color: var(--text-3); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; }
  .actions button { display: inline-flex; align-items: center; gap: 3px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text-2); font-size: 10px; cursor: pointer; }
</style>
