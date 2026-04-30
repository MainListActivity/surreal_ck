<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import RecordForm from "../components/RecordForm.svelte";
  import { coerceGridFieldValue, validateGridFieldValue } from "../../../../shared/field-schema";

  let draft = $state<Record<string, unknown>>({});
  let fieldErrors = $state<Record<string, string>>({});

  $effect(() => {
    if (!editorUi.showAdd) return;
    draft = Object.fromEntries(editorStore.columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]));
    fieldErrors = {};
  });

  function close() {
    editorUi.showAdd = false;
    draft = {};
    fieldErrors = {};
  }

  async function submit() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
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

    const ok = await editorStore.saveRows([{ values }]);
    if (ok) close();
  }
</script>

<div class="modal-backdrop" role="presentation" onmousedown={close}>
  <div
    class="modal record"
    role="dialog"
    aria-modal="true"
    aria-label="新增记录"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    <header>
      <strong>新增记录</strong>
      <button class="icon-btn" onclick={close}><Icon name="x" size={16} /></button>
    </header>
    <div class="record-form">
      <RecordForm columns={editorStore.columns} values={draft} errors={fieldErrors} />
    </div>
    <footer>
      {#if editorStore.saveError}
        <span class="modal-error">{editorStore.saveError}</span>
      {/if}
      <button class="secondary-btn" onclick={close}>取消</button>
      <button class="primary-btn" onclick={submit}>确认新增</button>
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .modal {
    width: min(480px, calc(100vw - 32px));
    max-height: 90vh;
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
  }

  .modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }

  .record-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 10px;
    max-height: 66vh;
    overflow: auto;
    margin: 18px 20px;
  }

  .record footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  .modal-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }

  .record footer button {
    padding: 8px 20px;
  }
</style>
