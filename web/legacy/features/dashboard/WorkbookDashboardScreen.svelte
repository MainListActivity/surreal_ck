<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import { dashboardsStore } from "../../lib/dashboards.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import type {
    DashboardViewDTO,
    DashboardViewDraftDTO,
    DashboardWidgetLayoutDTO,
  } from "../../../shared/rpc.types";
  import DashboardWidgetFrame from "./DashboardWidgetFrame.svelte";
  import DashboardViewBuilder from "./DashboardViewBuilder.svelte";
  import { getDashboardWidget } from "./registries/widgets";

  type ModalState = { mode: "create" } | { mode: "edit"; view: DashboardViewDTO };

  let modal = $state<ModalState | null>(null);

  const tableOptions = $derived(
    editorStore.sheets.map((sheet) => ({ table: sheet.tableName, label: sheet.label })),
  );

  const workbookId = $derived(editorStore.data?.workbook.id ?? "");
  const workspaceId = $derived(editorStore.data?.workbook.workspaceId ?? "");

  function openCreate() {
    if (!dashboardsStore.activePage) return;
    dashboardsStore.clearPreview();
    modal = { mode: "create" };
  }

  function openEdit(view: DashboardViewDTO) {
    dashboardsStore.clearPreview();
    modal = { mode: "edit", view };
  }

  function closeModal() {
    modal = null;
    dashboardsStore.clearPreview();
  }

  async function handleSubmit(draft: DashboardViewDraftDTO) {
    const page = dashboardsStore.activePage;
    if (!page || !modal) return;

    if (modal.mode === "edit") {
      const updated = await dashboardsStore.updateView(modal.view.id, draft);
      if (updated) closeModal();
      return;
    }

    const nextIndex = page.widgets.length;
    const widget: Omit<DashboardWidgetLayoutDTO, "viewId"> = {
      id: `widget_${Date.now().toString(36)}`,
      titleOverride: draft.title.trim() || undefined,
      grid: {
        x: (nextIndex % 2) * 6,
        y: Math.floor(nextIndex / 2) * 2,
        w: 6,
        h: draft.viewType === "kpi" ? 1 : 2,
      },
    };
    const created = await dashboardsStore.createViewAndAttach(draft, widget);
    if (created) closeModal();
  }

  async function switchPage(pageId: string) {
    await dashboardsStore.loadPage(pageId);
  }

  async function removeWidget(widgetId: string) {
    await dashboardsStore.removeWidget(widgetId);
  }
</script>

<section class="dashboard-page">
  <header class="dashboard-toolbar">
    <div class="page-switcher">
      {#each dashboardsStore.pages as page (page.id)}
        <button class:active={dashboardsStore.activePageId === page.id} onclick={() => void switchPage(page.id)}>
          {page.title}
        </button>
      {/each}
    </div>
    <div class="toolbar-actions">
      <button class="secondary-btn" onclick={() => dashboardsStore.refreshPage()} disabled={!dashboardsStore.activePageId}>
        <Icon name="refresh" size={14} />刷新
      </button>
      <button class="primary-btn" onclick={openCreate} disabled={!dashboardsStore.activePage}>
        <Icon name="plus" size={14} color="#fff" />添加图表
      </button>
    </div>
  </header>

  {#if dashboardsStore.error}
    <div class="state error">{dashboardsStore.error}</div>
  {:else if dashboardsStore.loading && !dashboardsStore.activePage}
    <div class="state">加载仪表盘…</div>
  {:else if !dashboardsStore.activePage}
    <div class="state">
      <EmptyState icon="coins" title="暂无仪表盘" desc="在左侧创建仪表盘后，可在这里添加图表。" />
    </div>
  {:else if dashboardsStore.activePage.widgets.length === 0}
    <div class="state">
      <EmptyState icon="coins" title="添加首个图表" desc="从智能表数据中创建汇总、趋势和占比图表。" />
    </div>
  {:else}
    <div class="widget-grid">
      {#each dashboardsStore.activePage.widgets as widget (widget.id)}
        {@const view = dashboardsStore.viewsById[widget.viewId]}
        {@const cache = dashboardsStore.cachesByViewId[widget.viewId]}
        {#if view}
          {@const registration = getDashboardWidget(view.viewType)}
          <div class="widget-cell" style={`grid-column: ${Math.max(1, widget.grid.x + 1)} / span ${Math.max(3, Math.min(widget.grid.w, 12))}; grid-row: ${Math.max(1, widget.grid.y + 1)} / span ${Math.max(1, widget.grid.h)}; min-height:${widget.grid.h === 1 ? 220 : 340}px;`}>
            <DashboardWidgetFrame
              title={widget.titleOverride || view.title}
              subtitle={cache?.executedAt ? `更新于 ${new Date(cache.executedAt).toLocaleString("zh-CN")}` : "尚未刷新"}
              onEdit={() => openEdit(view)}
              onRemove={() => removeWidget(widget.id)}
            >
              {#if registration}
                {@const WidgetComponent = registration.component}
                <WidgetComponent {view} {cache} />
              {/if}
            </DashboardWidgetFrame>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if modal}
    <div class="builder-mask" role="presentation" onclick={closeModal}>
      <section class="builder-modal" role="dialog" aria-modal="true" onclick={(event) => event.stopPropagation()}>
        <div class="modal-head">
          <strong>{modal.mode === "edit" ? "编辑图表" : "添加图表"}</strong>
          <button class="icon-btn" onclick={closeModal}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <DashboardViewBuilder
          {workspaceId}
          workbookId={workbookId || undefined}
          {tableOptions}
          initialView={modal.mode === "edit" ? modal.view : undefined}
          onSubmit={handleSubmit}
          onCancel={closeModal}
          saving={dashboardsStore.saving}
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
    background: #f4f6f9;
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
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, .9);
    color: var(--text-2);
  }

  .page-switcher button.active {
    border-color: rgba(22, 100, 255, .22);
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .toolbar-actions {
    display: flex;
    gap: 10px;
  }

  .widget-grid {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 16px;
  }

  .widget-cell {
    min-width: 0;
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
