<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";
  import { viewRegistry } from "./registries/views";
  import { toolRegistry, getTool } from "./registries/tools";

  const selectedCount = $derived(editorUi.selectedRowId ? 1 : 0);
  const activeToolEntry = $derived(
    editorUi.activeTool ? getTool(editorUi.activeTool) ?? null : null,
  );

  async function clickTool(toolId: string, event: MouseEvent) {
    event.stopPropagation();
    const tool = getTool(toolId);
    if (tool?.command) {
      await tool.command();
      return;
    }
    editorUi.toggleTool(toolId);
  }
</script>

<div class="toolbar">
  <div class="view-tabs">
    {#each viewRegistry as item}
      <button class:active={editorUi.view === item.id} onclick={() => (editorUi.view = item.id)}>
        <Icon name={item.icon} size={13} />{item.label}
      </button>
    {/each}
  </div>
  <span class="divider"></span>
  {#each toolRegistry as action}
    <button
      class="tool-btn"
      class:active={editorUi.activeTool === action.id}
      onclick={(event) => clickTool(action.id, event)}
    >
      <Icon name={action.icon} size={13} />{action.label}
    </button>
  {/each}
  <div class="toolbar-fill"></div>
  {#if selectedCount > 0}
    <span class="selected-hint">已选 {selectedCount} 条</span>
  {/if}
  <button
    class="compact ghost-btn"
    onclick={() => (editorUi.showFields = true)}
    disabled={appState.readOnly || !editorStore.activeSheetId}
  >
    <Icon name="settings" size={13} />字段
  </button>
  <button
    class="primary-btn compact"
    onclick={() => (editorUi.showAdd = true)}
    disabled={appState.readOnly || !editorStore.activeSheetId}
  >
    <Icon name="plus" size={13} color="#fff" />新增记录
  </button>
  <button class="compact ghost-btn" disabled={appState.readOnly}>
    <Icon name="upload" size={13} />导入
  </button>
</div>

{#if activeToolEntry}
  <div class="toolbar-note">
    {#if activeToolEntry.panel}
      {@const ToolPanel = activeToolEntry.panel}
      <ToolPanel />
    {:else}
      {editorUi.clipboardStatus}
    {/if}
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    height: 40px;
    flex-shrink: 0;
    align-items: center;
    gap: 2px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .toolbar-note {
    display: flex;
    height: 28px;
    flex-shrink: 0;
    align-items: center;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: #f7f8fa;
    color: var(--text-3);
    font-size: 11px;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .view-tabs {
    display: flex;
    align-self: stretch;
  }

  .view-tabs button,
  .toolbar > button {
    display: flex;
    height: 28px;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
  }

  .view-tabs button {
    position: relative;
    height: 40px;
    border-radius: 0;
  }

  .view-tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .view-tabs button.active::after {
    position: absolute;
    right: 10px;
    bottom: 0;
    left: 10px;
    height: 2px;
    background: var(--primary);
    content: "";
  }

  .tool-btn.active {
    border: 1px solid var(--primary);
    background: var(--primary-light);
    color: var(--primary);
  }

  .ghost-btn {
    border: 1px solid var(--border) !important;
    background: var(--surface) !important;
  }

  .toolbar-fill {
    flex: 1;
  }

  .selected-hint {
    margin-right: 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .compact {
    height: 28px;
    padding: 0 12px;
  }

  .compact:disabled {
    opacity: .55;
    cursor: not-allowed;
  }
</style>
