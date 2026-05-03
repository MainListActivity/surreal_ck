<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { dashboardsStore } from "../../lib/dashboards.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";

  async function openSheet(sheetId: string) {
    editorUi.pageKind = "sheet";
    editorUi.dashboardPageId = null;
    if (editorStore.activeSheetId !== sheetId) {
      editorUi.selectRow(null);
      await editorStore.switchSheet(sheetId);
    }
  }

  async function createSheet() {
    if (appState.readOnly || editorStore.saving) return;
    editorUi.pageKind = "sheet";
    editorUi.dashboardPageId = null;
    await editorStore.addSheet();
  }

  async function openDashboard(pageId: string) {
    editorUi.pageKind = "dashboard";
    editorUi.dashboardPageId = pageId;
    if (dashboardsStore.activePageId !== pageId) {
      await dashboardsStore.loadPage(pageId);
    }
  }

  async function createDashboard() {
    if (appState.readOnly || dashboardsStore.saving) return;
    const created = await dashboardsStore.createPage(`仪表盘 ${dashboardsStore.pages.length + 1}`);
    if (!created) return;
    editorUi.pageKind = "dashboard";
    editorUi.dashboardPageId = created.id;
  }
</script>

<aside class="workbook-nav">
  <div class="section">
    <div class="section-head">
      <span>智能表</span>
      <button class="icon-btn" title="新建智能表" disabled={appState.readOnly || editorStore.saving} onclick={createSheet}>
        <Icon name="plus" size={14} />
      </button>
    </div>

    <div class="item-list">
      {#each editorStore.sheets as sheet, index (sheet.id)}
        <button
          class="nav-item"
          class:active={editorUi.pageKind === "sheet" && editorStore.activeSheetId === sheet.id}
          onclick={() => void openSheet(sheet.id)}
          title={sheet.label}
        >
          <Icon name="grid" size={15} />
          <span>{sheet.label || `智能表${index + 1}`}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <span>仪表盘</span>
      <button class="icon-btn" title="新建仪表盘" disabled={appState.readOnly || dashboardsStore.saving} onclick={createDashboard}>
        <Icon name="plus" size={14} />
      </button>
    </div>

    <div class="item-list">
      {#if dashboardsStore.pages.length === 0}
        <div class="empty-hint">暂无仪表盘</div>
      {/if}
      {#each dashboardsStore.pages as page (page.id)}
        <button
          class="nav-item"
          class:active={editorUi.pageKind === "dashboard" && editorUi.dashboardPageId === page.id}
          onclick={() => void openDashboard(page.id)}
          title={page.title}
        >
          <Icon name="coins" size={15} />
          <span>{page.title}</span>
        </button>
      {/each}
    </div>
  </div>
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
  }

  .empty-hint {
    padding: 10px 12px;
    color: var(--text-3);
    font-size: 12px;
  }
</style>
