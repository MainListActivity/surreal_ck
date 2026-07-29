<script lang="ts">
  import { onMount } from "svelte";
  import { AlertTriangle, Bell, Check, RefreshCw } from "@lucide/svelte";
  import type { QuotaInAppNotification } from "@surreal-ck/shared/native-quota";
  import {
    loadQuotaNotifications,
    markQuotaNotificationRead,
  } from "../../lib/quota/client";
  import {
    formatQuotaCount,
    formatQuotaDate,
    quotaApiErrorMessage,
  } from "../../lib/quota/presentation";

  let {
    onopenquota,
  }: {
    onopenquota?: (slug: string) => void;
  } = $props();

  let open = $state(false);
  let loading = $state(false);
  let error = $state("");
  let notifications = $state<readonly QuotaInAppNotification[]>([]);
  const unread = $derived(notifications.filter((item) => item.read_at === null).length);

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      notifications = await loadQuotaNotifications();
    } catch (cause) {
      error = quotaApiErrorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function openNotification(notification: QuotaInAppNotification) {
    if (notification.read_at === null) {
      try {
        await markQuotaNotificationRead(notification.id);
        notifications = notifications.map((item) =>
          item.id === notification.id
            ? { ...item, read_at: new Date().toISOString() }
            : item,
        );
      } catch {
        // Reading the detail is still useful if the read receipt races another tab.
      }
    }
    open = false;
    onopenquota?.(notification.workspace.slug);
  }

  onMount(() => {
    void load();
  });
</script>

<div class="notification-menu">
  <button
    type="button"
    class="icon-btn notify-btn"
    class:active={open}
    title="配额通知"
    aria-label={`配额通知${unread > 0 ? `，${unread} 条未读` : ""}`}
    aria-expanded={open}
    onclick={() => {
      open = !open;
      if (open) void load();
    }}
  >
    <Bell size={15} />
    {#if unread > 0}<span class="badge">{Math.min(unread, 9)}</span>{/if}
  </button>

  {#if open}
    <section class="popover" aria-label="配额通知列表">
      <header>
        <div>
          <strong>资源通知</strong>
          <span>{unread} 条未读</span>
        </div>
        <button type="button" aria-label="刷新通知" onclick={() => void load()}>
          <span class:spinning={loading}><RefreshCw size={13} /></span>
        </button>
      </header>

      {#if error}
        <div class="state error"><AlertTriangle size={15} />{error}</div>
      {:else if loading && notifications.length === 0}
        <div class="state">正在读取通知…</div>
      {:else if notifications.length === 0}
        <div class="state"><Check size={15} />暂无配额通知</div>
      {:else}
        <div class="list">
          {#each notifications as notification (notification.id)}
            <button
              type="button"
              class:unread={notification.read_at === null}
              onclick={() => void openNotification(notification)}
            >
              <span class="dot"></span>
              <div>
                <strong>
                  {notification.kind === "over_limit" ? "资源已超额" : `用量达到 ${notification.threshold_percent}%`}
                </strong>
                <p>{notification.workspace.name} · {notification.label}</p>
                <small>
                  {formatQuotaCount(notification.used)} / {formatQuotaCount(notification.limit)}
                  · {formatQuotaDate(notification.created_at)}
                </small>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .notification-menu { position: relative; }
  .icon-btn {
    position: relative;
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .icon-btn:hover, .icon-btn.active { background: var(--soft); color: var(--text-1); }
  .badge {
    position: absolute;
    top: -2px;
    right: -2px;
    display: grid;
    min-width: 15px;
    height: 15px;
    place-items: center;
    padding: 0 3px;
    border: 2px solid var(--surface);
    border-radius: 999px;
    background: #c44c3c;
    color: #fff;
    font-size: 8px;
    font-weight: 800;
  }
  .popover {
    position: absolute;
    z-index: 40;
    right: 0;
    bottom: calc(100% + 10px);
    width: min(360px, calc(100vw - 28px));
    overflow: hidden;
    border: 1px solid var(--border-dark);
    border-radius: 14px;
    background: var(--surface-2);
    box-shadow: 0 20px 48px rgba(34, 30, 23, .18);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
  }
  header div { display: grid; gap: 2px; }
  header strong { font-size: 13px; }
  header span { color: var(--text-3); font-size: 10px; }
  header button {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: var(--soft);
    color: var(--text-2);
    cursor: pointer;
  }
  .list { max-height: 340px; overflow-y: auto; }
  .list button {
    display: grid;
    width: 100%;
    grid-template-columns: 8px 1fr;
    gap: 9px;
    padding: 12px 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: #fff;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .list button:hover { background: var(--surface); }
  .list button.unread { background: #f7fbf4; }
  .dot { width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: transparent; }
  .unread .dot { background: var(--primary); }
  .list strong { font-size: 12px; }
  .list p { margin: 3px 0; color: var(--text-2); font-size: 11px; }
  .list small { color: var(--text-3); font-size: 10px; }
  .state {
    display: flex;
    min-height: 90px;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 18px;
    color: var(--text-3);
    font-size: 11px;
  }
  .state.error { color: #a44337; }
  .spinning { display: inline-flex; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
