<script lang="ts">
  import { editorStore } from "../../../lib/editor.svelte";

  let value = $state<string>(editorStore.viewParams.groupBy ?? "");

  function apply(next: string) {
    value = next;
    editorStore.setGroupBy(next === "" ? null : next);
  }
</script>

<div class="tool-panel">
  <header><strong>分组</strong></header>

  <p class="hint">选择一个字段作为分组依据；视图组件会根据该字段渲染分组 header。</p>

  <div class="row">
    <label>
      <input type="radio" name="groupby" value="" checked={value === ""} onchange={() => apply("")} />
      <span>不分组</span>
    </label>
    {#each editorStore.columns as col}
      <label>
        <input type="radio" name="groupby" value={col.key} checked={value === col.key} onchange={() => apply(col.key)} />
        <span>{col.label}</span>
      </label>
    {/each}
  </div>
</div>

<style>
  .tool-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
  }

  header {
    color: var(--text-1);
    font-size: 12px;
    font-weight: 600;
  }

  .hint {
    margin: 0;
    color: var(--text-3);
    font-size: 11px;
  }

  .row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 6px 14px;
  }

  label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
    font-size: 12px;
  }
</style>
