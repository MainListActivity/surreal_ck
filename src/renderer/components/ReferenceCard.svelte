<script lang="ts">
  import { referenceCache } from "../lib/reference-cache.svelte";
  import type { RecordIdString } from "../../shared/rpc.types";

  /** 固定尺寸的引用记录浮窗（hover 时展示）。 */
  let {
    id,
    x,
    y,
  }: {
    id: RecordIdString;
    x: number;
    y: number;
  } = $props();

  $effect(() => {
    referenceCache.ensure([id]);
  });

  const preview = $derived(referenceCache.get(id));
</script>

<div class="ref-card" style={`left:${x}px; top:${y}px;`} role="tooltip">
  {#if preview === undefined || preview === null}
    <div class="loading">加载中…</div>
  {:else if preview.missing}
    <div class="missing">已删除的记录 · {preview.table}</div>
  {:else}
    <div class="head">
      <strong>{preview.primaryLabel}</strong>
      <div class="meta">
        {#if preview.workbookName}
          <span>{preview.workbookName} / {preview.sheetName}</span>
        {:else}
          <span>系统：{preview.table === "app_user" ? "用户" : preview.table}</span>
        {/if}
      </div>
    </div>
    {#if preview.preview.length > 0}
      <ul class="fields">
        {#each preview.preview as field (field.key)}
          <li>
            <span class="k">{field.label}</span>
            <span class="v">{String(field.value ?? "—")}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="empty">无更多字段</div>
    {/if}
  {/if}
</div>

<style>
  .ref-card {
    position: fixed;
    z-index: 90;
    width: 300px;
    height: 180px;
    overflow: hidden;
    padding: 12px;
    border: 1px solid #dfe4ee;
    border-radius: 10px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 42px rgba(15, 23, 42, .16);
    backdrop-filter: blur(12px);
    pointer-events: none;
  }

  .head {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid #edf1f6;
  }

  .head strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-1);
    font-size: 13px;
  }

  .meta {
    margin-top: 2px;
    color: var(--text-3);
    font-size: 11px;
  }

  .fields {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .fields li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
    color: var(--text-2);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .fields .k {
    flex: 0 0 80px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fields .v {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading,
  .empty,
  .missing {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 12px;
  }

  .missing {
    color: var(--error, #e54848);
  }
</style>
