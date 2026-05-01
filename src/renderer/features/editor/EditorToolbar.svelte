<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";
  import { viewRegistry } from "./registries/views";
  import { toolRegistry, getTool } from "./registries/tools";

  const selectedCount = $derived(editorUi.selectedRowId ? 1 : 0);

  function badgeFor(toolId: string): number {
    const vp = editorStore.viewParams;
    if (toolId === "filter") return vp.filters?.length ?? 0;
    if (toolId === "sort") return vp.sorts?.length ?? 0;
    if (toolId === "hidden") return vp.hiddenFields?.length ?? 0;
    if (toolId === "group") return vp.groupBy ? 1 : 0;
    return 0;
  }

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
    {@const badge = badgeFor(action.id)}
    <button
      class="tool-btn"
      class:active={editorUi.activeTool === action.id}
      class:applied={badge > 0}
      onclick={(event) => clickTool(action.id, event)}
    >
      <Icon name={action.icon} size={13} />{action.label}
      {#if badge > 0}<span class="badge">{badge}</span>{/if}
    </button>
  {/each}
  <div class="toolbar-fill"></div>
  {#if selectedCount > 0}
    <span class="selected-hint">已选 {selectedCount} 条</span>
  {/if}
  <span class="header-hint">右键字段名可配置字段</span>
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

  .tool-btn.applied {
    color: var(--primary);
  }

  .badge {
    display: inline-flex;
    min-width: 14px;
    height: 14px;
    padding: 0 4px;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    background: var(--primary);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    margin-left: 2px;
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

  .header-hint {
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
