<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { canWriteEntityData as canWriteEntityDataFn } from "../../../lib/permissions.svelte";
  import { editorStore } from "../../../lib/editor-store.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import RecordForm from "../components/RecordForm.svelte";
  import { coerceGridFieldValue, validateGridFieldValue } from "@surreal-ck/shared/field-schema";

  let draft = $state<Record<string, unknown>>({});
  let fieldErrors = $state<Record<string, string>>({});
  const canWriteEntityData = $derived(canWriteEntityDataFn());

  // 可见性由 editorUi.showAdd 单向驱动到本地 open；用户关闭（Escape / 外点 / 关闭按钮）
  // 通过 onOpenChange 回流到 store，焦点陷阱 / scroll-lock / aria 交给 bits-ui Dialog。
  let open = $state(false);
  $effect(() => {
    open = editorUi.showAdd;
  });

  $effect(() => {
    if (!editorUi.showAdd) return;
    draft = Object.fromEntries(editorStore.columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]));
    fieldErrors = {};
  });

  function handleOpenChange(next: boolean) {
    editorUi.showAdd = next;
    if (!next) {
      draft = {};
      fieldErrors = {};
    }
  }

  async function submit() {
    if (!canWriteEntityData || !editorStore.activeSheetId) return;
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
    if (ok) editorUi.showAdd = false;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="record">
    <Dialog.Header>
      <Dialog.Title>新增记录</Dialog.Title>
    </Dialog.Header>
    <div class="record-form">
      <RecordForm columns={editorStore.columns} values={draft} errors={fieldErrors} />
    </div>
    <footer>
      {#if editorStore.saveError}
        <span class="modal-error">{editorStore.saveError}</span>
      {/if}
      <button class="secondary-btn" onclick={() => (editorUi.showAdd = false)}>取消</button>
      <button class="primary-btn" onclick={submit} disabled={!canWriteEntityData}>确认新增</button>
    </footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.record) {
    width: min(480px, calc(100vw - 32px));
    max-width: min(480px, calc(100vw - 32px));
  }

  .record-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 10px;
    max-height: 66vh;
    overflow: auto;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-error {
    margin-right: auto;
    color: var(--error);
    font-size: 12px;
  }

  footer button {
    padding: 8px 20px;
  }
</style>
