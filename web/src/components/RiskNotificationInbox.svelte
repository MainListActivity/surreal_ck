<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Bell, Check, ExternalLink, MessageCircleQuestion, Sparkles, X } from "@lucide/svelte";
  import { getSurreal } from "$lib/surreal";
  import {
    loadClaimsReminderSettings,
    loadRiskNotifications,
    resolveOfficeRequest,
    resolveRiskNotification,
    resolveRiskNotificationTarget,
    setClaimsReminderEnabled,
    wakeOfficeRequest,
    watchNotificationInbox,
    type ClaimsReminderSetting,
    type OfficeRequestAction,
    type RiskNotification,
  } from "$lib/risk-notifications";

  let {
    slug,
    onopenrecord,
    onaskai,
  }: {
    slug?: string;
    onopenrecord?: (target: { workbookId: string; sheetId: string; recordId: string }) => void;
    onaskai?: (notification: RiskNotification) => void;
  } = $props();

  let notifications = $state<RiskNotification[]>([]);
  let settings = $state<ClaimsReminderSetting[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  let unsubscribe: (() => void) | null = null;
  /** 每条请求的操作草稿与提交状态——提交中/唤醒失败要如实呈现，不假成功。 */
  let drafts = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let wakeErrors = $state<Record<string, string>>({});

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
    // LIVE 推送 + connected 重连后补快照：断线窗口的变更不会重推。
    unsubscribe = watchNotificationInbox(getSurreal(), () => void load());
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

  function requestLabel(action: OfficeRequestAction | null, resolution: string): string {
    if (action === "answered") return resolution ? `已答复：${resolution}` : "已答复";
    if (action === "rejected") return resolution ? `已拒绝：${resolution}` : "已拒绝";
    if (action === "cancelled") return "已取消";
    return resolution || "已处理";
  }

  /** 唤醒投递：失败如实抛出，调用方决定是否呈现重试入口。 */
  async function retryWake(notification: RiskNotification) {
    try {
      if (slug) await wakeOfficeRequest(slug, notification.id);
      wakeErrors = { ...wakeErrors, [notification.id]: "" };
    } catch (cause) {
      // 终态已落库，仅唤醒未送达——reconcile 会补投；同时保留人工重试入口。
      wakeErrors = { ...wakeErrors, [notification.id]: cause instanceof Error ? cause.message : "唤醒失败，可重试" };
    }
  }

  /**
   * 终态先落库，再唤醒请求员工。唤醒失败不吞错：resolution 已持久化，
   * 用户可点重试（同幂等键收敛，不会产生第二次后续执行）。
   */
  async function submitRequestResolution(notification: RiskNotification, action: OfficeRequestAction) {
    if (busy[notification.id]) return;
    const text = (drafts[notification.id] ?? "").trim();
    if (action === "answered" && !text) {
      wakeErrors = { ...wakeErrors, [notification.id]: "答复内容不能为空" };
      return;
    }
    busy = { ...busy, [notification.id]: true };
    wakeErrors = { ...wakeErrors, [notification.id]: "" };
    try {
      const outcome = await resolveOfficeRequest(getSurreal(), notification.id, { action, text });
      if (outcome.status === "not-visible") {
        wakeErrors = { ...wakeErrors, [notification.id]: "通知不存在或不在你的收件箱" };
        return;
      }
      await retryWake(notification);
      await load();
    } catch (cause) {
      wakeErrors = { ...wakeErrors, [notification.id]: cause instanceof Error ? cause.message : "提交失败" };
    } finally {
      busy = { ...busy, [notification.id]: false };
    }
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
      {#if notification.purpose === "office-request"}
        <article class="request" class:resolved={!!notification.resolvedAt}>
          <button class="summary" onclick={() => (expanded = expanded === notification.id ? null : notification.id)}>
            <span class="severity request-icon" aria-hidden="true"><MessageCircleQuestion size={12} /></span>
            <span>
              <strong>{notification.title}</strong>
              <small>{notification.fromEmployee ? `来自 ${notification.fromEmployee}` : "来自虚拟员工"}</small>
            </span>
            {#if notification.resolvedAt}
              <span class="badge">{requestLabel(notification.answerAction, notification.resolution).split("：")[0]}</span>
            {:else}
              <span class="badge pending">待处理</span>
            {/if}
          </button>
          {#if expanded === notification.id}
            <div class="detail">
              <p>{notification.body}</p>
              {#if notification.resolvedAt}
                <dl>
                  <div><dt>处理结果</dt><dd>{requestLabel(notification.answerAction, notification.resolution)}</dd></div>
                  <div><dt>处理时间</dt><dd>{formatTime(notification.resolvedAt)}</dd></div>
                  {#if notification.taskId}<div><dt>关联任务</dt><dd>{notification.taskId}</dd></div>{/if}
                </dl>
                {#if wakeErrors[notification.id]}
                  <p class="request-error" role="alert">{wakeErrors[notification.id]}</p>
                  <div class="actions">
                    <button
                      disabled={!!busy[notification.id]}
                      onclick={() => void retryWake(notification)}
                    >重试唤醒员工</button>
                  </div>
                {/if}
              {:else}
                {#if notification.questionType === "choice" && notification.options.length > 0}
                  <div class="options" role="group" aria-label="可选项">
                    {#each notification.options as option (option)}
                      <button
                        class="option"
                        class:selected={drafts[notification.id] === option}
                        onclick={() => (drafts = { ...drafts, [notification.id]: option })}
                      >{option}</button>
                    {/each}
                  </div>
                {/if}
                <textarea
                  rows="2"
                  placeholder={notification.questionType === "choice" ? "选择上方选项，或补充说明" : "填写答复"}
                  value={drafts[notification.id] ?? ""}
                  oninput={(e) => (drafts = { ...drafts, [notification.id]: e.currentTarget.value })}
                ></textarea>
                {#if wakeErrors[notification.id]}
                  <p class="request-error" role="alert">{wakeErrors[notification.id]}</p>
                {/if}
                <div class="actions">
                  <button
                    disabled={!!busy[notification.id]}
                    onclick={() => void submitRequestResolution(notification, "answered")}
                  ><Check size={12} />提交答复</button>
                  <button
                    disabled={!!busy[notification.id]}
                    onclick={() => void submitRequestResolution(notification, "rejected")}
                  ><X size={12} />拒绝</button>
                  <button
                    disabled={!!busy[notification.id]}
                    onclick={() => void submitRequestResolution(notification, "cancelled")}
                  >取消请求</button>
                </div>
              {/if}
            </div>
          {/if}
        </article>
      {:else}
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
      {/if}
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
  article.request { border-color: color-mix(in srgb, var(--primary, #2563eb) 35%, var(--border)); }
  article.request.resolved { opacity: 0.75; }
  .summary { display: grid; width: 100%; grid-template-columns: 4px 1fr auto; gap: 8px; padding: 9px; border: 0; background: transparent; color: var(--text-1); text-align: left; cursor: pointer; align-items: center; }
  .summary .severity { border-radius: 99px; background: var(--warning); }
  .urgent .summary .severity { background: var(--error); }
  .summary .severity.request-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; background: var(--primary, #2563eb); color: #fff; }
  .summary span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .summary strong { font-size: 12px; }
  .summary small { overflow: hidden; color: var(--text-3); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .badge { padding: 2px 6px; border-radius: 99px; background: var(--soft); color: var(--text-3); font-size: 10px; white-space: nowrap; }
  .badge.pending { color: var(--primary, #2563eb); }
  .detail { padding: 0 10px 10px 22px; color: var(--text-2); font-size: 11px; }
  .detail p { margin: 0 0 8px; line-height: 1.5; }
  dl { display: flex; flex-direction: column; gap: 4px; margin: 0 0 9px; }
  dl div { display: grid; grid-template-columns: 58px 1fr; gap: 6px; }
  dt { color: var(--text-3); }
  dd { margin: 0; overflow-wrap: anywhere; }
  textarea { width: 100%; box-sizing: border-box; margin: 0 0 6px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text-1); font-size: 11px; font-family: inherit; resize: vertical; }
  .options { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
  .option { padding: 3px 8px; border: 1px solid var(--border); border-radius: 99px; background: var(--surface); color: var(--text-2); font-size: 10px; cursor: pointer; }
  .option.selected { border-color: var(--primary, #2563eb); color: var(--primary, #2563eb); }
  .request-error { margin: 0 0 6px; color: var(--error); font-size: 10px; }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; }
  .actions button { display: inline-flex; align-items: center; gap: 3px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text-2); font-size: 10px; cursor: pointer; }
  .actions button:disabled { opacity: 0.5; cursor: default; }
</style>
