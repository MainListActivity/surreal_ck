<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { editorStore } from "../../lib/editor.svelte";

  let { onAddSheet }: { onAddSheet?: () => void | Promise<void> } = $props();
</script>

<footer class="sheets">
  <button title="新增 Sheet" disabled={!onAddSheet} onclick={() => onAddSheet?.()}>
    <Icon name="plus" size={14} />
  </button>
  {#each editorStore.sheets as sheet}
    <button
      class:active={editorStore.activeSheetId === sheet.id}
      onclick={() => void editorStore.switchSheet(sheet.id)}
    >
      {sheet.label}
    </button>
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
</style>
