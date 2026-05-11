<script lang="ts">
  import { onMount } from "svelte";
  import { appApi } from "../lib/app-api";
  import type { SyncDeadLetterDTO, SyncStatusDTO } from "../../shared/rpc.types";

  let status = $state<SyncStatusDTO | null>(null);
  let letters = $state<SyncDeadLetterDTO[]>([]);
  let open = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const label = $derived(getStatusLabel(status));
  const tone = $derived(getStatusTone(status));

  onMount(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (disposed) return;
      const result = await appApi.getSyncStatus();
      if (result.ok) status = result.data;
    }

    void tick();
    timer = setInterval(tick, 2000);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  });

  async function loadLetters() {
    loading = true;
    error = null;
    const result = await appApi.listDeadLetters({ limit: 100, offset: 0 });
    if (result.ok) {
      letters = result.data.items;
    } else {
      error = result.message;
    }
    loading = false;
  }

  async function togglePanel() {
    open = !open;
    if (open) await loadLetters();
  }

  async function forceReapply(id: string) {
    const result = await appApi.forceReapplyDeadLetter(id);
    if (!result.ok) {
      error = result.message;
      return;
    }
    await loadLetters();
  }

  async function discard(id: string) {
    if (!confirm("忽略后本地记录可能继续与远端不一致，确认忽略？")) return;
    const result = await appApi.discardDeadLetter(id);
    if (!result.ok) {
      error = result.message;
      return;
    }
    await loadLetters();
  }

  function getStatusLabel(value: SyncStatusDTO | null): string {
    if (!value) return "同步状态";
    if (value.incompatibleSchema) return "需更新客户端";
    if (value.localChangefeedStale) return "本地有未推送变更";
    if (!value.online) return "离线模式";
    if (value.deadLetterCount > 0) return `${value.deadLetterCount} 条未同步`;
    if (value.pendingCount > 0) return `同步中（${value.pendingCount}）`;
    return "已同步";
  }

  function getStatusTone(value: SyncStatusDTO | null): "ok" | "warn" | "error" | "muted" {
    if (!value) return "muted";
    if (value.incompatibleSchema || value.localChangefeedStale) return "error";
    if (!value.online || value.deadLetterCount > 0 || value.pendingCount > 0) return "warn";
    return "ok";
  }
</script>

<div class="sync-status electrobun-webkit-app-region-no-drag">
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
        <button class="ghost-btn small" type="button" onclick={loadLetters}>刷新</button>
      </div>

      {#if error}
        <div class="sync-error">{error}</div>
      {/if}

      <div class="sync-meta">
        <span>待推送 {status?.pendingCount ?? 0}</span>
        <span>未同步 {status?.deadLetterCount ?? 0}</span>
      </div>

      {#if loading}
        <div class="empty">加载中</div>
      {:else if letters.length === 0}
        <div class="empty">暂无未同步条目</div>
      {:else}
        <div class="letter-list">
          {#each letters as item}
            <div class="letter-row">
              <div class="letter-main">
                <strong>{item.targetTable}</strong>
                <span>{item.targetId}</span>
                <small>{item.errorMessage}</small>
              </div>
              <div class="letter-actions">
                <button class="secondary-btn small" type="button" onclick={() => forceReapply(item.id)}>远端覆盖</button>
                <button class="ghost-btn small" type="button" onclick={() => discard(item.id)}>忽略</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
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

  .sync-popover-header,
  .sync-meta,
  .letter-row,
  .letter-actions {
    display: flex;
    align-items: center;
  }

  .sync-popover-header {
    justify-content: space-between;
    margin-bottom: 10px;
    color: var(--text-1);
    font-size: 13px;
  }

  .sync-meta {
    gap: 10px;
    margin-bottom: 10px;
    color: var(--text-3);
    font-size: 12px;
  }

  .sync-error {
    margin-bottom: 10px;
    padding: 8px;
    border-radius: 7px;
    background: var(--error-bg);
    color: var(--error);
    font-size: 12px;
  }

  .empty {
    padding: 20px 0;
    color: var(--text-3);
    text-align: center;
    font-size: 12px;
  }

  .letter-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .letter-row {
    justify-content: space-between;
    gap: 12px;
    padding: 9px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .letter-main {
    display: grid;
    min-width: 0;
    gap: 3px;
    font-size: 12px;
  }

  .letter-main span,
  .letter-main small {
    overflow: hidden;
    color: var(--text-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .letter-actions {
    flex-shrink: 0;
    gap: 6px;
  }

  .small {
    height: 26px;
    padding: 0 8px;
    font-size: 12px;
  }
</style>
