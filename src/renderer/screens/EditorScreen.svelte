<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import type { Navigate } from "../lib/types";
  import EditorTopbar from "../features/editor/EditorTopbar.svelte";
  import EditorToolbar from "../features/editor/EditorToolbar.svelte";
  import EditorSheets from "../features/editor/EditorSheets.svelte";
  import RightPanel from "../features/editor/RightPanel.svelte";
  import AddRecordModal from "../features/editor/modals/AddRecordModal.svelte";
  import FieldsModal from "../features/editor/modals/FieldsModal.svelte";
  import ShareModal from "../features/editor/modals/ShareModal.svelte";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { getView } from "../features/editor/registries/views";
  import { getTool } from "../features/editor/registries/tools";

  let { navigate, workbookId }: { navigate: Navigate; workbookId?: string } = $props();

  const currentView = $derived(getView(editorUi.view));
  const activeToolEntry = $derived(
    editorUi.activeTool ? getTool(editorUi.activeTool) ?? null : null,
  );

  $effect(() => {
    if (workbookId) {
      void editorStore.loadWorkbook(workbookId);
    } else {
      editorStore.reset();
    }
  });

  function handleGlobalPointer(event: MouseEvent) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(".menu-wrap, .tool-overlay, .tool-btn, .field-menu, .field-modal")) return;
    editorUi.closeAllPopups();
  }

  onMount(() => document.addEventListener("mousedown", handleGlobalPointer));
  onDestroy(() => document.removeEventListener("mousedown", handleGlobalPointer));
</script>

<section class="editor">
  <EditorTopbar {navigate} />
  <EditorToolbar />

  <div class="body">
    <div class="main-view">
      {#if editorStore.loading}
        <div class="body-state">加载工作簿数据…</div>
      {:else if editorStore.error}
        <div class="body-state error">{editorStore.error}</div>
      {:else if !editorStore.activeSheetId}
        <div class="body-state">
          <EmptyState icon="grid" title="无数据" desc="工作簿不包含任何 Sheet" />
        </div>
      {:else if currentView}
        {@const ViewComponent = currentView.component}
        <ViewComponent />
      {/if}
    </div>

    {#if activeToolEntry}
      <div
        class="tool-overlay"
        class:has-panel={!!activeToolEntry.panel}
        role="presentation"
        onmousedown={(event) => event.stopPropagation()}
      >
        {#if activeToolEntry.panel}
          {@const ToolPanel = activeToolEntry.panel}
          <ToolPanel />
        {:else}
          <span class="tool-overlay-text">{editorUi.clipboardStatus}</span>
        {/if}
      </div>
    {/if}

    <RightPanel />
  </div>

  <EditorSheets />
</section>

{#if editorUi.showAdd}
  <AddRecordModal />
{/if}

{#if editorUi.editingFieldKey}
  <FieldsModal fieldKey={editorUi.editingFieldKey} />
{/if}

{#if editorUi.showShare}
  <ShareModal {workbookId} />
{/if}

<style>
  .editor {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
  }

  .body {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .main-view {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* 工具栏面板（筛选/排序/隐藏字段/分组）以浮层形式贴在表格主视图顶部，
     不占用 flex 布局空间，确保表格主视图始终保持原始大小。 */
  .tool-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 20;
    max-height: 320px;
    overflow: auto;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 6px 16px rgba(15, 23, 42, .08);
  }

  .tool-overlay:not(.has-panel) {
    display: flex;
    height: 28px;
    max-height: 28px;
    align-items: center;
    padding: 0 14px;
    background: #f7f8fa;
    box-shadow: none;
  }

  .tool-overlay-text {
    color: var(--text-3);
    font-size: 11px;
  }

  .body-state {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 13px;
  }

  .body-state.error {
    color: var(--error);
  }
</style>
