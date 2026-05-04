<script lang="ts">
  import { editorStore } from "../../../lib/editor.svelte";
  import { cardAccent, cardPillStyle } from "../lib/cell-style";

  const tableView = $derived(editorStore.tableViewAdapter);
  const cols = $derived(tableView.renderers);
</script>

<div class="gallery">
  {#each tableView.visibleRows.slice(0, 80) as row}
    <button class="gallery-card" onclick={() => tableView.actions.openRecord(row.id)}>
      <span
        class="gallery-strip"
        style={`background:${cardAccent(cols.status ? row.values[cols.status.key] : "")}`}
      ></span>
      <strong>{String(cols.title ? row.values[cols.title.key] ?? "—" : row.id)}</strong>
      {#if cols.amount}
        <span class="money">¥ {String(row.values[cols.amount.key] ?? "0")}</span>
      {/if}
      <div class="gallery-tags">
        {#if cols.status}
          <span class="pill" style={cardPillStyle(row.values[cols.status.key])}>
            {String(row.values[cols.status.key] ?? "未分类")}
          </span>
        {/if}
        {#if cols.secondary}
          <span>{String(row.values[cols.secondary.key] ?? "")}</span>
        {/if}
      </div>
      {#if cols.date}
        <small>{String(row.values[cols.date.key] ?? "")}</small>
      {/if}
    </button>
  {/each}
</div>

<style>
  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    align-content: start;
    gap: 12px;
    flex: 1;
    overflow: auto;
    padding: 20px 24px;
    background: var(--bg);
  }

  .gallery-card {
    position: relative;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    text-align: left;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .05);
    transition: box-shadow .15s ease, transform .15s ease;
  }

  .gallery-card:hover {
    box-shadow: 0 8px 24px rgba(0, 0, 0, .1);
    transform: translateY(-1px);
  }

  .gallery-card strong {
    display: block;
    margin-bottom: 6px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.4;
  }

  .gallery-strip {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 4px;
  }

  .gallery-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .gallery span {
    display: inline-flex;
    color: var(--text-2);
    font-size: 12px;
  }

  .gallery small {
    display: block;
    margin-top: 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .money {
    display: block;
    margin-bottom: 8px;
    color: #0070c0;
    font-size: 12px;
    font-weight: 600;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 20px;
    background: var(--pill-bg, var(--bg));
    color: var(--pill-color, var(--text-3));
    font-size: 10px;
    font-weight: 600;
  }
</style>
