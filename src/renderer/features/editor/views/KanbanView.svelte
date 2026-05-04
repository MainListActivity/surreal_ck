<script lang="ts">
  import { editorStore } from "../../../lib/editor.svelte";
  import { cardAccent } from "../lib/cell-style";

  const tableView = $derived(editorStore.tableViewAdapter);
  const cols = $derived(tableView.renderers);

  function statusOf(row: { values: Record<string, unknown> }) {
    return String(cols.status ? row.values[cols.status.key] ?? "未分类" : "全部");
  }

  const groups = $derived(
    Array.from(new Set(tableView.visibleRows.map(statusOf))).slice(0, 4),
  );

  function rowsOf(status: string) {
    return tableView.visibleRows.filter((row) => statusOf(row) === status).slice(0, 40);
  }
</script>

<div class="kanban">
  {#each groups as status}
    <section class="kanban-col">
      <header>
        <span class="dot" style={`background:${cardAccent(status)}`}></span>
        <strong>{status}</strong>
        <span>({tableView.visibleRows.filter((row) => statusOf(row) === status).length})</span>
      </header>
      <div class="kanban-list">
        {#each rowsOf(status) as row}
          <button class="kanban-card" onclick={() => tableView.actions.openRecord(row.id)}>
            <strong>{String(cols.title ? row.values[cols.title.key] ?? "—" : row.id)}</strong>
            {#if cols.amount}
              <span class="money">¥ {String(row.values[cols.amount.key] ?? "0")}</span>
            {/if}
            <div class="kanban-meta">
              {#if cols.secondary}<span>{String(row.values[cols.secondary.key] ?? "")}</span>{/if}
              {#if cols.date}<span>{String(row.values[cols.date.key] ?? "")}</span>{/if}
            </div>
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .kanban {
    display: flex;
    gap: 14px;
    flex: 1;
    align-items: flex-start;
    overflow: auto;
    padding: 16px 20px;
    background: var(--bg);
  }

  .kanban-col {
    width: 240px;
    flex-shrink: 0;
  }

  .kanban-col header {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 10px;
  }

  .kanban-col header strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .kanban-col header span:last-child {
    color: var(--text-3);
    font-size: 11px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .kanban-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .kanban-card {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    text-align: left;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .05);
  }

  .kanban-card:hover {
    box-shadow: 0 8px 24px rgba(0, 0, 0, .1);
    transform: translateY(-1px);
  }

  .kanban-card strong {
    display: block;
    margin-bottom: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
  }

  .money {
    display: block;
    margin-bottom: 8px;
    color: #0070c0;
    font-size: 12px;
    font-weight: 600;
  }

  .kanban-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--text-3);
    font-size: 11px;
  }
</style>
