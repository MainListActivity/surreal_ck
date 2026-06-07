<script lang="ts">
  import { onMount, untrack } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import EditorTopbar from "../features/editor/EditorTopbar.svelte";
  import EditorToolbar from "../features/editor/EditorToolbar.svelte";
  import EditorWorkbookNav from "../features/editor/EditorWorkbookNav.svelte";
  import RightPanel from "../features/editor/RightPanel.svelte";
  import AddRecordModal from "../features/editor/modals/AddRecordModal.svelte";
  import LeaveDraftModal from "../features/editor/modals/LeaveDraftModal.svelte";
  import ShareModal from "../features/editor/modals/ShareModal.svelte";
  import { editorUi } from "../features/editor/lib/editor-ui.svelte";
  import { getTool } from "../features/editor/registries/tools";
  import { getView } from "../features/editor/registries/views";
  import { createEditorRouteController } from "../lib/editor-route-controller";
  import { editorPath, type Route } from "../lib/route";
  import { editorStore } from "../lib/editor-store.svelte";

  type Props = {
    slug: string;
    workbookId: string;
    sheetId?: string | null;
    onback?: () => void;
    onroute?: (path: string) => void;
  };

  let { slug, workbookId, sheetId = null, onback, onroute }: Props = $props();
  let viewportWidth = $state(1440);

  const routeController = createEditorRouteController({
    loadWorkbook: (id, nextSheetId) => editorStore.loadWorkbook(id, nextSheetId),
    switchSheet: (nextSheetId) => editorStore.switchSheet(nextSheetId),
    resetEditor: () => {
      editorStore.reset();
      editorUi.selectRow(null);
    },
    enterSheetPage: () => {
      editorUi.pageKind = "sheet";
      editorUi.dashboardPageId = null;
    },
  });

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
    const route: Route = { kind: "editor", slug, workbookId, sheetId };
    untrack(() => {
      void routeController.open(route);
    });
  });

  function handleGlobalPointer(event: MouseEvent) {
    const target = event.target;
    if (
      target instanceof HTMLElement
      && target.closest(".menu-wrap, .tool-overlay, .tool-btn, .field-menu, .row-menu, .select-menu, .select-trigger")
    ) return;
    editorUi.closeAllPopups();
  }

  function handleSwitchSheet(nextSheetId: string) {
    onroute?.(editorPath(slug, workbookId, nextSheetId));
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
</script>

<section class="editor">
  <EditorTopbar workbookName={workbookId} {onback} />

  <div class="body">
    <EditorWorkbookNav onswitchsheet={handleSwitchSheet} />
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
        <div class="dashboard-stub">看板即将上线</div>
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

<!-- 可见性已由各 modal 内部读 editorUi 绑到 bits-ui Dialog 的 bind:open；此处无条件挂载 -->
<AddRecordModal />
<ShareModal {workbookId} />
<LeaveDraftModal />

<style>
  .editor {
    display: flex;
    min-height: 0;
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
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

  .tool-overlay {
    position: fixed;
    z-index: 20;
    max-height: min(420px, calc(100vh - 120px));
    overflow: auto;
    border: 1px solid rgba(219, 226, 236, .95);
    border-radius: 8px;
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
    border-radius: 8px;
    background: #f7f8fa;
    box-shadow: 0 8px 18px rgba(15, 23, 42, .08);
  }

  .tool-overlay-text {
    color: var(--text-3);
    font-size: 11px;
  }

  .body-state,
  .dashboard-stub {
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
