<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import WorkbookDashboardScreen from "../features/dashboard/WorkbookDashboardScreen.svelte";
  import EditorWorkbookNav from "../features/editor/EditorWorkbookNav.svelte";
  import { editorStore } from "../lib/editor.svelte";
  import { dashboardsStore } from "../lib/dashboards.svelte";
  import type { Navigate } from "../lib/types";
  import EditorTopbar from "../features/editor/EditorTopbar.svelte";
  import EditorToolbar from "../features/editor/EditorToolbar.svelte";
  import RightPanel from "../features/editor/RightPanel.svelte";
  import AddRecordModal from "../features/editor/modals/AddRecordModal.svelte";
  import FieldsModal from "../features/editor/modals/FieldsModal.svelte";
  import ShareModal from "../features/editor/modals/ShareModal.svelte";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { getView } from "../features/editor/registries/views";
  import { getTool } from "../features/editor/registries/tools";

  let { navigate, workbookId }: { navigate: Navigate; workbookId?: string } = $props();
  let viewportWidth = $state(1440);

  const currentView = $derived(getView(editorUi.view));
  const activeToolEntry = $derived(
    editorUi.activeTool ? getTool(editorUi.activeTool) ?? null : null,
  );
  const toolOverlayStyle = $derived.by(() => {
    const anchor = editorUi.activeToolAnchor;
    const tool = activeToolEntry;
    if (!anchor || !tool) return "";

    const panelWidth = Math.min(tool.panelWidth ?? 360, viewportWidth - 24);
    const left = Math.max(12, Math.min(anchor.left, viewportWidth - panelWidth - 12));
    const top = anchor.top + anchor.height + 8;
    const minWidth = Math.max(anchor.width, Math.min(panelWidth, 240));

    return `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${Math.round(panelWidth)}px;min-width:${Math.round(minWidth)}px;`;
  });

  $effect(() => {
    const id = workbookId;
    untrack(() => {
      if (id) {
        editorUi.pageKind = "sheet";
        editorUi.dashboardPageId = null;
        void editorStore.loadWorkbook(id);
      } else {
        editorStore.reset();
      }
    });
  });

  $effect(() => {
    const workbook = editorStore.data?.workbook;
    if (!workbook?.id) return;
    untrack(() => {
      void dashboardsStore.loadForWorkbook(workbook.workspaceId, workbook.id, editorUi.dashboardPageId ?? undefined, false);
    });
  });

  function handleGlobalPointer(event: MouseEvent) {
    const target = event.target;
    if (
      target instanceof HTMLElement
      && target.closest(".menu-wrap, .tool-overlay, .tool-btn, .field-menu, .field-modal, .row-menu, .select-menu, .select-trigger")
    ) return;
    editorUi.closeAllPopups();
  }

  onMount(() => {
    viewportWidth = window.innerWidth;
    const handleResize = () => {
      viewportWidth = window.innerWidth;
    };
    document.addEventListener("mousedown", handleGlobalPointer);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleGlobalPointer);
      window.removeEventListener("resize", handleResize);
    };
  });

  onDestroy(() => document.removeEventListener("mousedown", handleGlobalPointer));
</script>

<section class="editor">
  <EditorTopbar {navigate} />

  <div class="body">
    <EditorWorkbookNav />
    <div class="main-view">
      {#if editorStore.loading}
        <div class="body-state">加载工作簿数据…</div>
      {:else if editorStore.error}
        <div class="body-state error">{editorStore.error}</div>
      {:else if !editorStore.activeSheetId}
        <div class="body-state">
          <EmptyState icon="grid" title="无数据" desc="工作簿不包含任何 Sheet" />
        </div>
      {:else if editorUi.pageKind === "dashboard"}
        <WorkbookDashboardScreen />
      {:else}
        <EditorToolbar />
        {#if currentView}
        {@const ViewComponent = currentView.component}
          <ViewComponent />
        {/if}
      {/if}
    </div>

    {#if activeToolEntry}
      <div
        class="tool-overlay"
        class:has-panel={!!activeToolEntry.panel}
        role="presentation"
        style={toolOverlayStyle}
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
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .tool-overlay {
    position: fixed;
    z-index: 20;
    max-height: min(420px, calc(100vh - 120px));
    overflow: auto;
    border: 1px solid rgba(219, 226, 236, .95);
    border-radius: 18px;
    background: rgba(255, 255, 255, .98);
    box-shadow:
      0 24px 48px rgba(15, 23, 42, .14),
      0 8px 20px rgba(15, 23, 42, .08);
    backdrop-filter: blur(16px);
  }

  .tool-overlay:not(.has-panel) {
    display: flex;
    height: 28px;
    max-height: 28px;
    align-items: center;
    padding: 0 14px;
    background: #f7f8fa;
    border-radius: 10px;
    box-shadow: 0 8px 18px rgba(15, 23, 42, .08);
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
