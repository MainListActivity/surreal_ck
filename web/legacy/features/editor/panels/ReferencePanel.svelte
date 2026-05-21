<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { referenceCache } from "../../../lib/reference-cache.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  const targetId = $derived(editorUi.referencePanel.targetId);

  $effect(() => {
    if (targetId) referenceCache.ensure([targetId]);
  });

  const preview = $derived(targetId ? referenceCache.get(targetId) : undefined);

  function back() {
    editorUi.closeReferencePanel();
  }
</script>

<div class="ref-panel">
  <div class="bar">
    <button class="back" type="button" onclick={back} aria-label="返回">
      <Icon name="arrowLeft" size={14} />
      <span>返回</span>
    </button>
  </div>

  {#if !targetId}
    <div class="empty">未选中引用</div>
  {:else if preview === undefined || preview === null}
    <div class="empty">加载中…</div>
  {:else if preview.missing}
    <div class="empty error">已删除的记录 · {preview.table}</div>
  {:else}
    <header class="hero">
      <strong>{preview.primaryLabel}</strong>
      <span class="meta">
        {#if preview.workbookName}
          {preview.workspaceName ?? ""} / {preview.workbookName} / {preview.sheetName}
        {:else if preview.table === "app_user"}
          系统：用户
        {:else}
          {preview.table}
        {/if}
      </span>
      <code class="rid">{preview.id}</code>
    </header>
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
      <div class="empty">无更多字段可展示</div>
    {/if}
  {/if}
</div>

<style>
  .ref-panel {
    display: grid;
    gap: 12px;
  }

  .bar {
    display: flex;
    margin-bottom: 4px;
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }

  .back:hover {
    color: var(--primary);
    border-color: var(--primary);
  }

  .hero {
    display: grid;
    gap: 4px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .hero strong {
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.3;
  }

  .meta {
    color: var(--text-3);
    font-size: 11px;
  }

  .rid {
    color: var(--text-3);
    font-size: 10.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    word-break: break-all;
  }

  .fields {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .fields li {
    display: grid;
    grid-template-columns: 86px 1fr;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px dashed var(--border);
  }

  .fields .k {
    color: var(--text-3);
    font-size: 11.5px;
  }

  .fields .v {
    color: var(--text-1);
    font-size: 12.5px;
    word-break: break-word;
  }

  .empty {
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
    padding: 24px 12px;
  }

  .empty.error {
    color: var(--error, #e54848);
  }
</style>
