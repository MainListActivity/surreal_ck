<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import { Plus, Pencil, Trash2, RefreshCw, X, Coins } from "@lucide/svelte";
  import type { DashboardWidget } from "../../lib/dashboard-data";
  import { editorStore } from "../../lib/editor-store.svelte";
  import { editorUi } from "../editor/lib/editor-ui.svelte";
  import DashboardViewBuilder from "./DashboardViewBuilder.svelte";
  import DashboardWidgetFrame from "./DashboardWidgetFrame.svelte";
  import { dashboardStore } from "./lib/dashboard-store.svelte";
  import { getDashboardWidget } from "./registries/widgets";

  type ModalState = { mode: "create" } | { mode: "edit"; widget: DashboardWidget };

  let modal = $state<ModalState | null>(null);
  /** 页/widget 写操作（PERMISSIONS 拒绝等）的最近一次错误，中文展示。 */
  let actionError = $state<string | null>(null);

  const tables = $derived(
    editorStore.sheets.map((sheet) => ({
      table: sheet.tableName,
      label: sheet.label,
      columns: sheet.columns,
    })),
  );
  const activePage = $derived(dashboardStore.activePage);

  async function switchPage(pageId: string) {
    actionError = null;
    editorUi.dashboardPageId = pageId;
    if (dashboardStore.activePageId !== pageId) {
      await dashboardStore.selectPage(pageId);
    }
  }

  async function createPage() {
    const title = window.prompt("新仪表盘页的标题", `仪表盘 ${dashboardStore.pages.length + 1}`);
    if (title === null) return;
    actionError = null;
    const result = await dashboardStore.createPage(title.trim() || "未命名仪表盘");
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    editorUi.dashboardPageId = dashboardStore.activePageId;
  }

  async function renamePage() {
    if (!activePage) return;
    const title = window.prompt("仪表盘页标题", activePage.title);
    if (title === null || !title.trim()) return;
    actionError = null;
    const result = await dashboardStore.renamePage(activePage.id, title.trim());
    if (!result.ok) actionError = result.message;
  }

  async function deletePage() {
    if (!activePage) return;
    if (!window.confirm(`删除仪表盘页「${activePage.title}」？该页全部图表将一并移除。`)) return;
    actionError = null;
    const result = await dashboardStore.deletePage(activePage.id);
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    editorUi.dashboardPageId = dashboardStore.activePageId;
  }

  async function removeWidget(widget: DashboardWidget) {
    if (!window.confirm(`移除图表「${widget.title}」？`)) return;
    actionError = null;
    const result = await dashboardStore.removeWidget(widget.id);
    if (!result.ok) actionError = result.message;
  }

  async function handleSubmit(widget: DashboardWidget) {
    actionError = null;
    const result = await dashboardStore.upsertWidget(widget);
    if (!result.ok) {
      actionError = result.message;
      return;
    }
    modal = null;
  }

  function widgetSubtitle(widgetId: string): string {
    const data = dashboardStore.widgetData[widgetId];
    if (!data || data.status === "loading") return "执行中…";
    if (data.status === "error") return "查询失败";
    return `更新于 ${new Date(data.updatedAt).toLocaleString("zh-CN")}`;
  }
</script>

<section class="dashboard-page">
  <header class="dashboard-toolbar">
    <div class="page-switcher">
      {#each dashboardStore.pages as page (page.id)}
        <button class:active={dashboardStore.activePageId === page.id} onclick={() => void switchPage(page.id)}>
          {page.title}
        </button>
      {/each}
      <button class="new-page" title="新建仪表盘页" onclick={() => void createPage()}>
        <Plus size={13} />新建页
      </button>
    </div>
    <div class="toolbar-actions">
      {#if activePage}
        <button class="secondary-btn" title="重命名当前页" onclick={() => void renamePage()}>
          <Pencil size={14} />改名
        </button>
        <button class="secondary-btn" title="删除当前页" onclick={() => void deletePage()}>
          <Trash2 size={14} />删除
        </button>
      {/if}
      <button class="secondary-btn" onclick={() => void dashboardStore.refresh()} disabled={!activePage}>
        <RefreshCw size={14} />刷新
      </button>
      <button class="primary-btn" onclick={() => (modal = { mode: "create" })} disabled={!activePage}>
        <Plus size={14} color="#fff" />添加图表
      </button>
    </div>
  </header>

  {#if actionError}
    <div class="action-error">{actionError}</div>
  {/if}

  {#if dashboardStore.error}
    <div class="state error">{dashboardStore.error}</div>
  {:else if dashboardStore.loading && !activePage}
    <div class="state">加载仪表盘…</div>
  {:else if !activePage}
    <div class="state">
      <EmptyState icon={Coins} title="暂无仪表盘" desc="点击「新建页」创建第一个仪表盘页。" />
    </div>
  {:else if activePage.widgets.length === 0}
    <div class="state">
      <EmptyState icon={Coins} title="添加首个图表" desc="从智能表数据中创建汇总、趋势和占比图表。" />
    </div>
  {:else}
    <div class="widget-grid">
      {#each activePage.widgets as widget (widget.id)}
        {@const registration = getDashboardWidget(widget.viewType)}
        {@const data = dashboardStore.widgetData[widget.id]}
        <div
          class="widget-cell"
          style={`grid-column: ${Math.max(1, widget.grid.x + 1)} / span ${Math.max(3, Math.min(widget.grid.w, 12))}; grid-row: ${Math.max(1, widget.grid.y + 1)} / span ${Math.max(1, widget.grid.h)}; min-height:${widget.grid.h === 1 ? 220 : 340}px;`}
        >
          <DashboardWidgetFrame
            title={widget.title}
            subtitle={widgetSubtitle(widget.id)}
            onEdit={() => (modal = { mode: "edit", widget })}
            onRemove={() => void removeWidget(widget)}
          >
            {#if data?.status === "error"}
              <div class="widget-error">{data.message}</div>
            {:else if registration}
              {@const WidgetComponent = registration.component}
              <WidgetComponent
                title={widget.title}
                result={data?.status === "ok" ? data.result : undefined}
                displaySpec={widget.display}
              />
            {:else}
              <div class="widget-error">未知图表类型：{widget.viewType}</div>
            {/if}
          </DashboardWidgetFrame>
        </div>
      {/each}
    </div>
  {/if}

  {#if modal}
    <div class="builder-mask" role="presentation" onclick={() => (modal = null)}>
      <section
        class="builder-modal"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => event.stopPropagation()}
      >
        <div class="modal-head">
          <strong>{modal.mode === "edit" ? "编辑图表" : "添加图表"}</strong>
          <button class="icon-btn" onclick={() => (modal = null)}>
            <X size={18} />
          </button>
        </div>
        <DashboardViewBuilder
          {tables}
          existingWidgets={activePage?.widgets ?? []}
          initialWidget={modal.mode === "edit" ? modal.widget : undefined}
          saving={dashboardStore.saving}
          onsubmit={handleSubmit}
          oncancel={() => (modal = null)}
        />
      </section>
    </div>
  {/if}
</section>

<style>
  .dashboard-page {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    padding: 18px 20px 20px;
    background: var(--bg);
    overflow: auto;
  }

  .dashboard-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }

  .page-switcher {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .page-switcher button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }

  .page-switcher button.active {
    border-color: var(--primary);
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .page-switcher button.new-page {
    border-style: dashed;
    color: var(--text-3);
  }

  .toolbar-actions {
    display: flex;
    gap: 10px;
  }

  .secondary-btn,
  .primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255, 255, 255, .9);
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
  }

  .primary-btn {
    border-color: var(--primary);
    background: var(--primary);
    color: #fff;
  }

  .secondary-btn:disabled,
  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-error {
    margin-bottom: 12px;
    padding: 10px 14px;
    border: 1px solid rgba(220, 38, 38, .25);
    border-radius: 10px;
    background: rgba(254, 242, 242, .9);
    color: var(--error);
    font-size: 12px;
  }

  .widget-grid {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 16px;
  }

  .widget-cell {
    min-width: 0;
  }

  .widget-error {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--error);
    font-size: 12px;
    text-align: center;
  }

  .state {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 320px;
  }

  .state.error {
    color: var(--error);
  }

  .builder-mask {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, .18);
    backdrop-filter: blur(8px);
  }

  .builder-modal {
    display: flex;
    flex-direction: column;
    width: min(1440px, calc(100vw - 48px));
    height: min(860px, calc(100vh - 48px));
    border: 1px solid rgba(229, 230, 235, .8);
    border-radius: 24px;
    background: rgba(255, 255, 255, .98);
    overflow: hidden;
    box-shadow: 0 30px 90px rgba(15, 23, 42, .18);
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }

  .icon-btn {
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--soft);
    color: var(--text-1);
  }

  @media (max-width: 1180px) {
    .builder-modal {
      width: calc(100vw - 24px);
      height: calc(100vh - 24px);
    }
  }
</style>
