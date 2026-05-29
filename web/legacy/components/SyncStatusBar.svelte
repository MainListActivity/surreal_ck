<script lang="ts">
  import { onMount } from "svelte";
  import { appApi } from "../lib/app-api";
  import { applyAuthState } from "../lib/auth.svelte";
  import type { SyncStatusV2DTO } from "../../shared/rpc.types";

  let status = $state<SyncStatusV2DTO | null>(null);
  let open = $state(false);
  let rebuilding = $state(false);
  let reconnecting = $state(false);
  let error = $state<string | null>(null);
  let countdown = $state<number | null>(null);

  const label = $derived(getStatusLabel(status, rebuilding, reconnecting));
  const tone = $derived(getStatusTone(status, rebuilding, reconnecting));

  onMount(() => {
    let disposed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let countdownTimer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (disposed) return;
      const result = await appApi.getSyncStatusV2();
      if (result.ok) status = result.data;
    }

    function updateCountdown() {
      if (!status?.nextRetryAt) {
        countdown = null;
        return;
      }
      const remaining = Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 1000));
      countdown = remaining;
    }

    void tick();
    pollTimer = setInterval(tick, 2000);
    countdownTimer = setInterval(updateCountdown, 1000);

    // 浏览器网络恢复时立即触发一次重连
    function onOnline() {
      if (disposed) return;
      if (!status || status.online || status.needsRelogin) return;
      void reconnect();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }

    return () => {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (countdownTimer) clearInterval(countdownTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
    };
  });

  function togglePanel() {
    open = !open;
    error = null;
  }

  async function rebuild() {
    if (rebuilding) return;
    rebuilding = true;
    error = null;
    const result = await appApi.triggerSyncRebuild();
    if (result.ok) {
      status = result.data;
    } else {
      error = result.message;
    }
    rebuilding = false;
  }

  async function reconnect() {
    if (reconnecting) return;
    if (status?.needsRelogin) {
      applyAuthState({ loggedIn: false });
      return;
    }
    reconnecting = true;
    error = null;
    const result = await appApi.reconnectRemote();
    if (result.ok) {
      status = result.data.sync;
      if (result.data.status === "offline" && result.data.message) {
        error = result.data.message;
      } else if (result.data.status === "needs-relogin") {
        error = result.data.message ?? "refresh_token 已失效，请重新登录";
      }
    } else {
      error = result.message;
    }
    reconnecting = false;
  }

  function getStatusLabel(
    value: SyncStatusV2DTO | null,
    isRebuilding: boolean,
    isReconnecting: boolean,
  ): string {
    if (!value) return "同步状态";
    if (isRebuilding || value.rebuildInProgress) return "重建中";
    if (value.incompatibleSchema) return "需更新客户端";
    if (value.needsRelogin) return "需重新登录";
    if (isReconnecting || value.reconnecting) return "重连中…";
    if (!value.online) return "离线模式";
    if (value.dirtyStructureShadow || value.dirtyProjectionData) return "本地需重建";
    return "已同步";
  }

  function getStatusTone(
    value: SyncStatusV2DTO | null,
    isRebuilding: boolean,
    isReconnecting: boolean,
  ): "ok" | "warn" | "error" | "muted" {
    if (!value) return "muted";
    if (isRebuilding || value.rebuildInProgress) return "warn";
    if (value.incompatibleSchema || value.needsRelogin) return "error";
    if (isReconnecting || value.reconnecting) return "warn";
    if (value.dirtyStructureShadow || value.dirtyProjectionData) return "warn";
    if (!value.online) return "warn";
    return "ok";
  }

  function formatRebuildAt(value: string | undefined): string {
    if (!value) return "尚未重建";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }
</script>

<div class="sync-status desktop-webkit-app-region-no-drag">
  <button
    class:tone-ok={tone === "ok"}
    class:tone-warn={tone === "warn"}
    class:tone-error={tone === "error"}
    class:tone-muted={tone === "muted"}
    class="sync-pill"
    type="button"
    title={status?.lastError ?? label}
    onclick={togglePanel}
  >
    <span class="dot"></span>
    <span>{label}</span>
  </button>

  {#if open}
    <div class="sync-popover">
      <div class="sync-popover-header">
        <strong>同步详情</strong>
        <div class="sync-popover-actions">
          {#if status && !status.online}
            <button
              class="primary-btn small"
              type="button"
              disabled={reconnecting || status.reconnecting}
              onclick={reconnect}
            >
              {#if status.needsRelogin}
                重新登录
              {:else if reconnecting || status.reconnecting}
                重连中…
              {:else}
                立即重连
              {/if}
            </button>
          {/if}
          <button
            class="primary-btn small"
            type="button"
            disabled={rebuilding || status?.rebuildInProgress || !status?.online}
            onclick={rebuild}
          >
            {rebuilding || status?.rebuildInProgress ? "重建中…" : "重建本地派生状态"}
          </button>
        </div>
      </div>

      {#if error}
        <div class="sync-error">{error}</div>
      {/if}
      {#if status?.lastError && !error}
        <div class="sync-error">{status.lastError}</div>
      {/if}

      <dl class="sync-meta-grid">
        <dt>远端连通</dt>
        <dd>
          {status?.online ? "在线" : "离线"}
          {#if !status?.online && !status?.needsRelogin && countdown !== null && countdown >= 0}
            <span class="muted">（{countdown}s 后自动重试）</span>
          {/if}
        </dd>
        <dt>本地结构影子</dt>
        <dd>{status?.dirtyStructureShadow ? "需重建（dirty）" : "健康"}</dd>
        <dt>投影数据区</dt>
        <dd>{status?.dirtyProjectionData ? "需重建（dirty）" : "健康"}</dd>
        <dt>客户端 schema</dt>
        <dd>{status?.incompatibleSchema ? "版本不兼容" : "兼容"}</dd>
        <dt>当前是否重建</dt>
        <dd>{status?.rebuildInProgress ? "是" : "否"}</dd>
        <dt>最近重建时间</dt>
        <dd>{formatRebuildAt(status?.lastRebuildAt)}</dd>
      </dl>
    </div>
  {/if}
</div>

<style>
  .sync-status {
    position: relative;
    margin-right: 8px;
    -webkit-app-region: no-drag;
  }

  .sync-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
  }

  .tone-ok .dot { background: var(--success); }
  .tone-warn .dot { background: var(--warning); }
  .tone-error .dot { background: var(--error); }
  .tone-muted .dot { background: var(--text-3); }

  .sync-popover {
    position: absolute;
    top: 32px;
    right: 0;
    z-index: 1000;
    width: min(520px, calc(100vw - 32px));
    max-height: 480px;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 12px 36px rgba(0, 0, 0, .16);
  }

  .sync-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    color: var(--text-1);
    font-size: 13px;
  }

  .sync-popover-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .muted {
    color: var(--text-3);
    font-size: 11px;
    margin-left: 4px;
  }

  .sync-error {
    margin-bottom: 10px;
    padding: 8px;
    border-radius: 7px;
    background: var(--error-bg);
    color: var(--error);
    font-size: 12px;
  }

  .sync-meta-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 12px;
    margin: 0;
    color: var(--text-2);
    font-size: 12px;
  }

  .sync-meta-grid dt {
    color: var(--text-3);
  }

  .sync-meta-grid dd {
    margin: 0;
    color: var(--text-1);
  }

  .small {
    height: 26px;
    padding: 0 8px;
    font-size: 12px;
  }
</style>
