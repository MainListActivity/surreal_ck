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
  .right-panel {
    width: 0;
    flex-shrink: 0;
    overflow: hidden;
    border-left: 0;
    background: var(--surface);
    transition: width .2s ease;
  }

  .right-panel.open {
    width: 320px;
    border-left: 1px solid var(--border);
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
