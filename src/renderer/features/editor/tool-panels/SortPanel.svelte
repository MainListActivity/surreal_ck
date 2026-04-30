<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import type { SortClause } from "../../../../shared/rpc.types";

  type SortDraft = SortClause & { id: number };

  let nextId = 0;
  let drafts = $state<SortDraft[]>(
    (editorStore.viewParams.sorts ?? []).map((s) => ({ ...s, id: nextId++ })),
  );

  function defaultKey(): string {
    return editorStore.columns[0]?.key ?? "";
  }

  function addClause() {
    drafts = [...drafts, { id: nextId++, key: defaultKey(), direction: "asc" }];
  }

  function removeClause(id: number) {
    drafts = drafts.filter((d) => d.id !== id);
  }

  function moveUp(index: number) {
    if (index <= 0) return;
    const next = drafts.slice();
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    drafts = next;
  }

  function moveDown(index: number) {
    if (index >= drafts.length - 1) return;
    const next = drafts.slice();
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    drafts = next;
  }

  async function apply() {
    const cleaned: SortClause[] = drafts
      .filter((d) => editorStore.columns.some((c) => c.key === d.key))
      .map(({ id: _id, ...rest }) => rest);
    await editorStore.setSorts(cleaned);
  }

  async function clearAll() {
    drafts = [];
    await editorStore.setSorts([]);
  }
</script>

<div class="tool-panel">
  <header><strong>排序</strong></header>

  {#if drafts.length === 0}
    <p class="hint">未添加排序，结果按数据库默认顺序返回</p>
  {/if}

  {#each drafts as draft, index (draft.id)}
    <div class="row">
      <span class="rank">{index + 1}</span>
      <select bind:value={draft.key}>
        {#each editorStore.columns as col}
          <option value={col.key}>{col.label}</option>
        {/each}
      </select>
      <select bind:value={draft.direction}>
        <option value="asc">升序</option>
        <option value="desc">降序</option>
      </select>
      <button class="icon-btn" onclick={() => moveUp(index)} disabled={index === 0} title="上移">↑</button>
      <button class="icon-btn" onclick={() => moveDown(index)} disabled={index === drafts.length - 1} title="下移">↓</button>
      <button class="icon-btn" onclick={() => removeClause(draft.id)} title="删除">
        <Icon name="x" size={12} />
      </button>
    </div>
  {/each}

  <footer>
    <button class="ghost-btn" onclick={addClause}>
      <Icon name="plus" size={12} />添加排序
    </button>
    <div class="spacer"></div>
    {#if drafts.length > 0}
      <button class="ghost-btn" onclick={clearAll}>清空</button>
    {/if}
    <button class="primary-btn" onclick={apply} disabled={editorStore.loading}>应用</button>
  </footer>
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
    grid-template-columns: 24px 1fr 100px 24px 24px 24px;
    align-items: center;
    gap: 8px;
  }

  .rank {
    color: var(--text-3);
    font-size: 11px;
    text-align: center;
  }

  select {
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    outline: none;
  }

  .icon-btn {
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .icon-btn:not(:disabled):hover {
    background: var(--bg);
    color: var(--text-1);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
    margin-top: 4px;
  }

  .spacer {
    flex: 1;
  }

  .ghost-btn {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .primary-btn {
    height: 26px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
  }

  .primary-btn:disabled {
    opacity: 0.5;
  }
</style>
