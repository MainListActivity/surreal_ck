<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";
  import { panelRegistry, getPanel } from "./registries/panels";

  const current = $derived(getPanel(editorUi.panelTab));
</script>

<aside class="right-panel" class:open={editorUi.panelOpen}>
  {#if editorUi.panelOpen}
    <div class="panel-tabs">
      {#each panelRegistry as tab}
        <button
          class:active={editorUi.panelTab === tab.id}
          onclick={() => (editorUi.panelTab = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
      <button class="close" onclick={() => (editorUi.panelOpen = false)}>
        <Icon name="x" size={14} />
      </button>
    </div>
    <div class="panel-content">
      {#if current}
        {@const PanelComponent = current.component}
        <PanelComponent />
      {/if}
    </div>
  {/if}
</aside>

<style>
  /* 右侧详情面板以浮层形式贴在表格主视图右侧，
     不占用 flex 布局空间，确保表格主视图始终保持原始大小。 */
  .right-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 25;
    width: 0;
    overflow: hidden;
    border-left: 0;
    background: var(--surface);
    transition: width .2s ease;
    pointer-events: none;
  }

  .right-panel.open {
    width: 320px;
    border-left: 1px solid var(--border);
    box-shadow: -6px 0 16px rgba(15, 23, 42, .08);
    pointer-events: auto;
  }

  .panel-tabs {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }

  .panel-tabs button {
    height: 42px;
    padding: 0 9px;
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
  }

  .panel-tabs button.active {
    color: var(--primary);
    font-weight: 650;
  }

  .panel-tabs .close {
    margin-left: auto;
  }

  .panel-content {
    height: calc(100% - 43px);
    overflow: auto;
    padding: 14px 16px;
  }
</style>
