<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  let draft = $state<Record<string, string>>({});

  function close() {
    editorUi.showAdd = false;
    draft = {};
  }

  async function submit() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    const values: Record<string, unknown> = {};
    for (const col of editorStore.columns) {
      values[col.key] = draft[col.key] ?? "";
    }
    await editorStore.saveRows([{ values }]);
    close();
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
      {#each editorStore.columns as col}
        <label>
          <span>{col.label}{#if col.required}<b>*</b>{/if}</span>
          {#if col.options?.length}
            <select bind:value={draft[col.key]}>
              <option value="">请选择</option>
              {#each col.options as opt}<option>{opt}</option>{/each}
            </select>
          {:else}
            <input bind:value={draft[col.key]} placeholder={col.label} />
          {/if}
        </label>
      {/each}
    </div>
    <footer>
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

  .record-form label {
    display: block;
  }

  .record-form label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
  }

  input,
  select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  b {
    color: var(--error);
  }

  .record footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  .record footer button {
    padding: 8px 20px;
  }
</style>
