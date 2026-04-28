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

  let { navigate, workbookId }: { navigate: Navigate; workbookId?: string } = $props();

  const currentView = $derived(getView(editorUi.view));

  $effect(() => {
    if (workbookId) {
      void editorStore.loadWorkbook(workbookId);
    } else {
      editorStore.reset();
    }
  });

  function handleGlobalPointer(event: MouseEvent) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(".menu-wrap")) return;
    editorUi.closeAllPopups();
  }

  onMount(() => document.addEventListener("mousedown", handleGlobalPointer));
  onDestroy(() => document.removeEventListener("mousedown", handleGlobalPointer));
</script>

<section class="editor">
  <EditorTopbar {navigate} />
  <EditorToolbar />

  <div class="body">
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

    <RightPanel />
  </div>

  <EditorSheets />
</section>

{#if editorUi.showAdd}
  <AddRecordModal />
{/if}

{#if editorUi.showFields}
  <FieldsModal />
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
    display: flex;
    min-height: 0;
    flex: 1;
    overflow: hidden;
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
