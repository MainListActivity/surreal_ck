<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../../components/Icon.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";

  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");
  let renameInputEl = $state<HTMLInputElement | null>(null);

  async function gotoSheet(sheetId: string) {
    if (renamingId) return;
    if (editorStore.activeSheetId === sheetId) return;
    editorUi.selectRow(null);
    await editorStore.switchSheet(sheetId);
  }

  async function startRename(sheetId: string, currentLabel: string) {
    if (appState.readOnly) return;
    renamingId = sheetId;
    renameDraft = currentLabel;
    await tick();
    renameInputEl?.focus();
    renameInputEl?.select();
  }

  async function commitRename() {
    if (!renamingId) return;
    const id = renamingId;
    const next = renameDraft.trim();
    renamingId = null;
    if (!next) return;
    await editorStore.renameSheet(id, next);
  }

  function cancelRename() {
    renamingId = null;
    renameDraft = "";
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement).blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  }

  async function handleAddSheet() {
    if (appState.readOnly || editorStore.saving) return;
    await editorStore.addSheet();
  }
</script>

<footer class="sheets">
  <button
    title="新增 Sheet"
    disabled={appState.readOnly || editorStore.saving}
    onclick={handleAddSheet}
  >
    <Icon name="plus" size={14} />
  </button>
  {#each editorStore.sheets as sheet (sheet.id)}
    {#if renamingId === sheet.id}
      <span class="rename-wrap" class:active={editorStore.activeSheetId === sheet.id}>
        <input
          bind:this={renameInputEl}
          bind:value={renameDraft}
          onblur={commitRename}
          onkeydown={handleRenameKeydown}
          aria-label="Sheet 名称"
          maxlength="80"
        />
      </span>
    {:else}
      <button
        class:active={editorStore.activeSheetId === sheet.id}
        onclick={() => void gotoSheet(sheet.id)}
        ondblclick={() => void startRename(sheet.id, sheet.label)}
        title={appState.readOnly ? sheet.label : `${sheet.label}（双击重命名）`}
      >
        {sheet.label}
      </button>
    {/if}
  {/each}
</footer>

<style>
  .sheets {
    display: flex;
    height: 36px;
    flex-shrink: 0;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
    border-top: 1px solid var(--border);
    background: var(--soft);
  }

  .sheets button {
    height: 28px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px 6px 0 0;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }

  .sheets button.active {
    border-bottom: 2px solid var(--primary);
    background: var(--surface);
    color: var(--primary);
    font-weight: 650;
  }

  .sheets button:disabled {
    opacity: .4;
    cursor: not-allowed;
  }

  .rename-wrap {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px 6px 0 0;
    background: var(--surface);
  }

  .rename-wrap.active {
    border-bottom: 2px solid var(--primary);
  }

  .rename-wrap input {
    height: 22px;
    width: 120px;
    padding: 0 6px;
    border: 1px solid var(--primary);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    outline: none;
  }
</style>
