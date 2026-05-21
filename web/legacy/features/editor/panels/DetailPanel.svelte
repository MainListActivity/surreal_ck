<script lang="ts">
  import EmptyState from "../../../components/EmptyState.svelte";
  import { editorStore, isDraftRowId } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import { cardPillStyle } from "../lib/cell-style";
  import RecordForm from "../components/RecordForm.svelte";
  import { deriveColumns } from "../lib/derived-columns";
  import { coerceGridFieldValue, validateGridFieldValue } from "../../../../shared/field-schema";

  const cols = $derived(deriveColumns(editorStore.columns));
  const selectedRow = $derived(
    editorUi.selectedRowId
      ? editorStore.rows.find((r) => r.id === editorUi.selectedRowId) ?? null
      : null,
  );

  let draft = $state<Record<string, unknown>>({});
  let fieldErrors = $state<Record<string, string>>({});

  $effect(() => {
    draft = Object.fromEntries(
      editorStore.columns.map((col) => [
        col.key,
        selectedRow?.values[col.key] ?? (col.fieldType === "checkbox" ? false : null),
      ]),
    );
    fieldErrors = {};
  });

  async function submit() {
    if (!selectedRow) return;
    const values: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const col of editorStore.columns) {
      const coerced = coerceGridFieldValue(draft[col.key], col);
      const errors = validateGridFieldValue(coerced, col);
      values[col.key] = coerced;
      if (errors.length) nextErrors[col.key] = errors[0];
    }
    fieldErrors = nextErrors;
    if (Object.keys(nextErrors).length) return;

    if (isDraftRowId(selectedRow.id)) {
      const result = await editorStore.commitDraftEdit(selectedRow.id, values);
      if (result.promoted && result.newId) {
        editorUi.selectRow(result.newId);
      }
    } else {
      await editorStore.saveRows([{ id: selectedRow.id, values }]);
    }
  }
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
  <RecordForm columns={editorStore.columns} values={draft} errors={fieldErrors} dense={true} />
  <div class="panel-actions">
    {#if editorStore.saveError}
      <span class="panel-error">{editorStore.saveError}</span>
    {/if}
    <button class="primary-btn" onclick={submit} disabled={editorStore.saving}>保存当前记录</button>
  </div>
{:else}
  <EmptyState
    icon="info"
    title="未选择记录"
    desc="在表格 / 看板 / 画廊视图中选中一行查看详情，或切换到「表单视图」新增记录"
  />
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

  .panel-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .panel-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }
</style>
