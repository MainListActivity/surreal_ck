<script lang="ts">
  import { onMount } from "svelte";
  import { appApi } from "../lib/app-api";
  import type { SyncStatusV2DTO } from "../../shared/rpc.types";

  let status = $state<SyncStatusV2DTO | null>(null);
  let open = $state(false);
  let rebuilding = $state(false);
  let error = $state<string | null>(null);

  const label = $derived(getStatusLabel(status, rebuilding));
  const tone = $derived(getStatusTone(status, rebuilding));

  onMount(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (disposed) return;
      const result = await appApi.getSyncStatusV2();
      if (result.ok) status = result.data;
    }

    void tick();
    timer = setInterval(tick, 2000);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
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

  function getStatusLabel(value: SyncStatusV2DTO | null, isRebuilding: boolean): string {
    if (!value) return "同步状态";
    if (isRebuilding || value.rebuildInProgress) return "重建中";
    if (value.incompatibleSchema) return "需更新客户端";
    if (!value.online) return "离线模式";
    if (value.dirtyStructureShadow) return "本地需重建";
    return "已同步";
  }

  function getStatusTone(
    value: SyncStatusV2DTO | null,
    isRebuilding: boolean,
  ): "ok" | "warn" | "error" | "muted" {
    if (!value) return "muted";
    if (isRebuilding || value.rebuildInProgress) return "warn";
    if (value.incompatibleSchema) return "error";
    if (value.dirtyStructureShadow) return "warn";
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
        <button
          class="primary-btn small"
          type="button"
          disabled={rebuilding || status?.rebuildInProgress || !status?.online}
          onclick={rebuild}
        >
          {rebuilding || status?.rebuildInProgress ? "重建中…" : "重建本地派生状态"}
        </button>
      </div>

      {#if error}
        <div class="sync-error">{error}</div>
      {/if}
      {#if status?.lastError && !error}
        <div class="sync-error">{status.lastError}</div>
      {/if}

      <dl class="sync-meta-grid">
        <dt>远端连通</dt>
        <dd>{status?.online ? "在线" : "离线"}</dd>
        <dt>本地结构影子</dt>
        <dd>{status?.dirtyStructureShadow ? "需重建（dirty）" : "健康"}</dd>
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
