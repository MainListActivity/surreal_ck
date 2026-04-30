<script lang="ts">
  import { editorStore } from "../../../lib/editor.svelte";

  const hidden = $derived(new Set(editorStore.viewParams.hiddenFields ?? []));

  function toggle(key: string) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    editorStore.setHiddenFields(Array.from(next));
  }

  function showAll() {
    editorStore.setHiddenFields([]);
  }

  function hideAll() {
    editorStore.setHiddenFields(editorStore.columns.map((c) => c.key));
  }
</script>

<div class="tool-panel">
  <header>
    <strong>隐藏字段</strong>
    <div class="actions">
      <button class="link" onclick={showAll}>全部显示</button>
      <span class="sep">·</span>
      <button class="link" onclick={hideAll}>全部隐藏</button>
    </div>
  </header>

  <div class="grid">
    {#each editorStore.columns as col}
      <label class="item">
        <input type="checkbox" checked={!hidden.has(col.key)} onchange={() => toggle(col.key)} />
        <span>{col.label}</span>
      </label>
    {/each}
  </div>
</div>

<style>
  .tool-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-1);
    font-size: 12px;
    font-weight: 600;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 400;
  }

  .link {
    border: 0;
    background: transparent;
    color: var(--primary);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
  }

  .sep {
    color: var(--text-3);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 6px 14px;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
    font-size: 12px;
  }
</style>
