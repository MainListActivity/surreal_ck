<script lang="ts">
  import { tick } from "svelte";
  import { ChevronRight, ChevronLeft, Grid3x3, Coins, Pencil, Check, X } from "@lucide/svelte";
  import { dashboardStore } from "../dashboard/lib/dashboard-store.svelte";
  import { editorStore } from "../../lib/editor-store.svelte";
  import { canWriteSharedStructure as canWriteSharedStructureFn } from "../../lib/permissions.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";
  import type { SheetMeta } from "../../lib/editor-store.svelte";

  let { onswitchsheet }: { onswitchsheet?: (sheetId: string) => void } = $props();

  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());

  let collapsed = $state(false);
  let renamingSheetId = $state<string | null>(null);
  let renameDraft = $state("");
  let committingRename = $state(false);
  let renameInputEl = $state<HTMLInputElement | null>(null);

  async function openSheet(sheetId: string) {
    editorUi.pageKind = "sheet";
    editorUi.dashboardPageId = null;
    if (editorStore.activeSheetId === sheetId) return;
    editorUi.selectRow(null);
    if (onswitchsheet) {
      onswitchsheet(sheetId);
      return;
    }
    await editorStore.switchSheet(sheetId);
  }

  async function openDashboard(pageId: string) {
    editorUi.pageKind = "dashboard";
    editorUi.dashboardPageId = pageId;
    if (dashboardStore.activePageId !== pageId) {
      await dashboardStore.selectPage(pageId);
    }
  }

  async function startRenameSheet(event: MouseEvent, sheet: SheetMeta, label: string) {
    event.stopPropagation();
    if (!canWriteSharedStructure) return;
    renamingSheetId = sheet.id;
    renameDraft = label;
    await tick();
    renameInputEl?.focus();
    renameInputEl?.select();
  }

  function cancelRenameSheet() {
    renamingSheetId = null;
    renameDraft = "";
  }

  async function commitRenameSheet() {
    if (!renamingSheetId || committingRename) return;
    const id = renamingSheetId;
    const next = renameDraft.trim();
    const current = editorStore.sheets.find((sheet) => sheet.id === id);
    if (current && next === current.label) {
      cancelRenameSheet();
      return;
    }
    committingRename = true;
    const ok = await editorStore.renameSheet(id, next);
    committingRename = false;
    if (ok) cancelRenameSheet();
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRenameSheet();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameSheet();
    }
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
  }
</script>

<aside class="workbook-nav" class:collapsed>
  {#if collapsed}
    <button
      type="button"
      class="collapsed-trigger"
      title="点击展开侧栏"
      aria-label="展开侧栏"
      onclick={toggleCollapsed}
    >
      <ChevronRight size={16} />
      <span class="collapsed-hint">展开</span>
    </button>
  {:else}
    <div class="nav-header">
      <span class="nav-header-title">侧栏</span>
      <button class="icon-btn collapse-btn-inline" title="收起侧栏" onclick={toggleCollapsed}>
        <ChevronLeft size={14} />
      </button>
    </div>

    <div class="section">
      <div class="section-head">
        <span>智能表</span>
      </div>

      <div class="item-list">
        {#if editorStore.sheets.length === 0}
          <div class="empty-hint">暂无智能表</div>
        {/if}
        {#each editorStore.sheets as sheet, index (sheet.id)}
          {@const label = sheet.label || `智能表${index + 1}`}
          {#if renamingSheetId === sheet.id}
            <div
              class="nav-item editing"
              class:active={editorUi.pageKind === "sheet" && editorStore.activeSheetId === sheet.id}
            >
              <Grid3x3 size={15} />
              <input
                bind:this={renameInputEl}
                bind:value={renameDraft}
                disabled={committingRename}
                aria-label="智能表名称"
                onblur={() => void commitRenameSheet()}
                onkeydown={handleRenameKeydown}
              />
              <button
                type="button"
                class="item-icon"
                title="保存名称"
                aria-label="保存名称"
                disabled={committingRename}
                onmousedown={(event) => event.preventDefault()}
                onclick={() => void commitRenameSheet()}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                class="item-icon"
                title="取消重命名"
                aria-label="取消重命名"
                disabled={committingRename}
                onmousedown={(event) => event.preventDefault()}
                onclick={cancelRenameSheet}
              >
                <X size={13} />
              </button>
            </div>
          {:else}
            <div
              class="nav-item"
              class:active={editorUi.pageKind === "sheet" && editorStore.activeSheetId === sheet.id}
              role="button"
              tabindex="0"
              onclick={() => void openSheet(sheet.id)}
              ondblclick={(event) => void startRenameSheet(event, sheet, label)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void openSheet(sheet.id);
                }
              }}
              title={canWriteSharedStructure ? `${label}（双击重命名）` : label}
            >
              <Grid3x3 size={15} />
              <span>{label}</span>
              {#if canWriteSharedStructure}
                <button
                  type="button"
                  class="item-icon rename-trigger"
                  title="重命名智能表"
                  aria-label="重命名智能表"
                  onmousedown={(event) => event.preventDefault()}
                  onclick={(event) => void startRenameSheet(event, sheet, label)}
                >
                  <Pencil size={13} />
                </button>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span>仪表盘</span>
        <button
          class="icon-btn"
          title="打开仪表盘"
          onclick={() => {
            editorUi.pageKind = "dashboard";
            editorUi.dashboardPageId = dashboardStore.activePageId;
          }}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div class="item-list">
        {#if dashboardStore.pages.length === 0}
          <div class="empty-hint">暂无仪表盘</div>
        {/if}
        {#each dashboardStore.pages as page (page.id)}
          <div
            class="nav-item"
            class:active={editorUi.pageKind === "dashboard" && editorUi.dashboardPageId === page.id}
            role="button"
            tabindex="0"
            onclick={() => void openDashboard(page.id)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void openDashboard(page.id);
              }
            }}
            title={page.title}
          >
            <Coins size={15} />
            <span>{page.title}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</aside>

<style>
  .workbook-nav {
    display: flex;
    width: 220px;
    flex-shrink: 0;
    flex-direction: column;
    gap: 18px;
    padding: 16px 12px;
    border-right: 1px solid var(--border);
    background: linear-gradient(180deg, #fbfcff 0%, #f7f8fa 100%);
    overflow: auto;
    transition: width .18s ease;
    position: relative;
  }

  .workbook-nav.collapsed {
    width: 36px;
    padding: 0;
    align-items: stretch;
    gap: 0;
  }

  .collapsed-trigger {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 16px 0;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .collapsed-trigger:hover {
    background: rgba(22, 100, 255, .06);
    color: var(--primary);
  }

  .collapsed-trigger:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }

  .collapsed-hint {
    writing-mode: vertical-rl;
    font-size: 11px;
    letter-spacing: .12em;
  }

  .nav-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    margin-bottom: -4px;
  }

  .nav-header-title {
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
  }

  .collapse-btn-inline {
    color: var(--text-3);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    padding: 0 4px;
  }

  .item-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .nav-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }

  .nav-item:hover {
    background: rgba(22, 100, 255, .06);
    color: var(--text-1);
  }

  .nav-item.active {
    background: rgba(22, 100, 255, .1);
    color: var(--primary);
    font-weight: 650;
  }

  .nav-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .nav-item.editing {
    cursor: default;
  }

  .nav-item input {
    min-width: 0;
    height: 24px;
    flex: 1;
    border: 1px solid var(--primary);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 13px;
    padding: 0 6px;
    outline: 0;
  }

  .item-icon {
    display: inline-flex;
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .item-icon:hover:not(:disabled) {
    background: rgba(22, 100, 255, .08);
  }

  .item-icon:disabled {
    cursor: default;
    opacity: .55;
  }

  .rename-trigger {
    opacity: 0;
  }

  .nav-item:hover .rename-trigger,
  .nav-item:focus-within .rename-trigger {
    opacity: 1;
  }

  .empty-hint {
    padding: 10px 12px;
    color: var(--text-3);
    font-size: 12px;
  }
</style>
