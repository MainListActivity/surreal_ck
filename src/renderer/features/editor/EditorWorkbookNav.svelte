<script lang="ts">
  import { tick } from "svelte";
  import Icon from "../../components/Icon.svelte";
  import { appState } from "../../lib/app-state.svelte";
  import { dashboardsStore } from "../../lib/dashboards.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import { editorUi } from "./lib/editor-ui.svelte";

  let collapsed = $state(false);
  /** 当前正在重命名的项标识：sheet:<id> 或 dashboard:<id>。 */
  let editingKey = $state<string | null>(null);
  let editingValue = $state("");

  async function openSheet(sheetId: string) {
    if (editingKey) return;
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
    if (editingKey) return;
    editorUi.pageKind = "dashboard";
    editorUi.dashboardPageId = pageId;
    if (dashboardsStore.activePageId !== pageId) {
      await dashboardsStore.loadPage(pageId);
    }
  }

  async function createDashboard() {
    if (appState.readOnly || dashboardsStore.saving) return;
    const workbook = editorStore.data?.workbook;
    if (!workbook) return;
    const created = await dashboardsStore.createPage(`仪表盘 ${dashboardsStore.pages.length + 1}`, {
      workspaceId: workbook.workspaceId,
      workbookId: workbook.id,
    });
    if (!created) {
      console.error("[dashboard] 新建失败:", dashboardsStore.error);
      return;
    }
    editorUi.pageKind = "dashboard";
    editorUi.dashboardPageId = created.id;
  }

  async function startEdit(key: string, currentLabel: string, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (appState.readOnly) return;
    editingKey = key;
    editingValue = currentLabel;
    await tick();
    const input = document.querySelector<HTMLInputElement>(`input[data-edit-key="${key}"]`);
    input?.focus();
    input?.select();
  }

  function cancelEdit() {
    editingKey = null;
    editingValue = "";
  }

  async function commitEdit() {
    const key = editingKey;
    if (!key) return;
    const trimmed = editingValue.trim();
    if (!trimmed) {
      cancelEdit();
      return;
    }
    const [kind, id] = splitKey(key);
    editingKey = null;
    editingValue = "";
    if (kind === "sheet") {
      await editorStore.renameSheet(id, trimmed);
    } else if (kind === "dashboard") {
      await dashboardsStore.renamePage(id, trimmed);
    }
  }

  function splitKey(key: string): ["sheet" | "dashboard", string] {
    const idx = key.indexOf(":");
    return [key.slice(0, idx) as "sheet" | "dashboard", key.slice(idx + 1)];
  }

  function onEditKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    if (collapsed) cancelEdit();
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
        <div class="head-actions">
          <button class="icon-btn" title="新建智能表" disabled={appState.readOnly || editorStore.saving} onclick={createSheet}>
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>

      <div class="item-list">
        {#each editorStore.sheets as sheet, index (sheet.id)}
          {@const key = `sheet:${sheet.id}`}
          {@const label = sheet.label || `智能表${index + 1}`}
          <div
            class="nav-item"
            class:active={editorUi.pageKind === "sheet" && editorStore.activeSheetId === sheet.id}
            class:editing={editingKey === key}
            role="button"
            tabindex="0"
            ondblclick={(event) => void startEdit(key, label, event)}
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
            {#if editingKey === key}
              <input
                class="rename-input"
                data-edit-key={key}
                bind:value={editingValue}
                onkeydown={onEditKeydown}
                onblur={() => void commitEdit()}
              />
            {:else}
              <span>{label}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span>仪表盘</span>
        <div class="head-actions">
          <button class="icon-btn" title="新建仪表盘" disabled={appState.readOnly || dashboardsStore.saving || !editorStore.data?.workbook} onclick={createDashboard}>
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>

      <div class="item-list">
        {#if dashboardsStore.pages.length === 0}
          <div class="empty-hint">暂无仪表盘</div>
        {/if}
        {#each dashboardsStore.pages as page (page.id)}
          {@const key = `dashboard:${page.id}`}
          <div
            class="nav-item"
            class:active={editorUi.pageKind === "dashboard" && editorUi.dashboardPageId === page.id}
            class:editing={editingKey === key}
            role="button"
            tabindex="0"
            ondblclick={(event) => void startEdit(key, page.title, event)}
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
            {#if editingKey === key}
              <input
                class="rename-input"
                data-edit-key={key}
                bind:value={editingValue}
                onkeydown={onEditKeydown}
                onblur={() => void commitEdit()}
              />
            {:else}
              <span>{page.title}</span>
            {/if}
          </div>
        {/each}
        {#if dashboardsStore.error}
          <div class="empty-hint error">{dashboardsStore.error}</div>
        {/if}
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

  .head-actions {
    display: flex;
    align-items: center;
    gap: 2px;
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

  .nav-item.editing {
    background: var(--surface);
    box-shadow: 0 0 0 1.5px var(--primary) inset;
  }

  .nav-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    border: 0;
    background: transparent;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    outline: none;
  }

  .empty-hint {
    padding: 10px 12px;
    color: var(--text-3);
    font-size: 12px;
  }

  .empty-hint.error {
    color: #d4380d;
  }
</style>
