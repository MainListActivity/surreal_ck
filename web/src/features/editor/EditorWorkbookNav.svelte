<script lang="ts">
  import Icon from "../../components/Icon.svelte";
  import { dashboardStore } from "../dashboard/lib/dashboard-store.svelte";
  import { editorStore } from "../../lib/editor-store.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";

  // 新建 / 重命名 sheet 属结构操作（原走已废弃后端 RPC），直连 DDL 留后续 issue；
  // 仪表盘页已是直连数据行（dashboard_page），列表与进入在此，管理在屏幕工具栏。
  let { onswitchsheet }: { onswitchsheet?: (sheetId: string) => void } = $props();

  let collapsed = $state(false);

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
      <Icon name="chevronRight" size={16} />
      <span class="collapsed-hint">展开</span>
    </button>
  {:else}
    <div class="nav-header">
      <span class="nav-header-title">侧栏</span>
      <button class="icon-btn collapse-btn-inline" title="收起侧栏" onclick={toggleCollapsed}>
        <Icon name="chevronLeft" size={14} />
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
          <div
            class="nav-item"
            class:active={editorUi.pageKind === "sheet" && editorStore.activeSheetId === sheet.id}
            role="button"
            tabindex="0"
            onclick={() => void openSheet(sheet.id)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void openSheet(sheet.id);
              }
            }}
            title={label}
          >
            <Icon name="grid" size={15} />
            <span>{label}</span>
          </div>
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
          <Icon name="chevronRight" size={14} />
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
            <Icon name="coins" size={15} />
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

  .empty-hint {
    padding: 10px 12px;
    color: var(--text-3);
    font-size: 12px;
  }
</style>
