<script lang="ts">
  import EmptyState from "../../../components/EmptyState.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import { cardPillStyle } from "../lib/cell-style";
  import { deriveColumns } from "../lib/derived-columns";

  const cols = $derived(deriveColumns(editorStore.columns));
  const selectedRow = $derived(
    editorUi.selectedRowId
      ? editorStore.rows.find((r) => r.id === editorUi.selectedRowId) ?? null
      : null,
  );
</script>

{#if selectedRow}
  <div class="panel-hero">
    <strong>
      {String(cols.title ? selectedRow.values[cols.title.key] ?? "—" : selectedRow.id)}
    </strong>
    {#if cols.status}
      <span class="pill" style={cardPillStyle(selectedRow.values[cols.status.key])}>
        {String(selectedRow.values[cols.status.key] ?? "未分类")}
      </span>
    {/if}
  </div>
  {#each editorStore.columns as col}
    <div class="field-row">
      <span>{col.label}</span>
      <strong>{String(selectedRow.values[col.key] ?? "—")}</strong>
    </div>
  {/each}
{:else}
  <EmptyState icon="info" title="请选择一行" desc="点击表格单元格后在此查看详情" />
{/if}

<style>
  .panel-hero {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .panel-hero strong {
    color: var(--text-1);
    font-size: 14px;
    font-weight: 700;
  }

  .field-row {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    line-height: 1.6;
  }

  .field-row span {
    width: 80px;
    flex-shrink: 0;
    color: var(--text-3);
    font-size: 11px;
  }

  .field-row strong {
    color: var(--text-1);
    font-weight: 500;
    word-break: break-all;
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
