<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import type { Navigate } from "../lib/types";
  import { appState } from "../lib/app-state.svelte";
  import { dashboardsStore } from "../lib/dashboards.svelte";
  import { appApi } from "../lib/app-api";
  import type {
    DashboardViewDTO,
    DashboardViewDraftDTO,
    DashboardWidgetLayoutDTO,
    ReferenceTargetOption,
  } from "../../shared/rpc.types";
  import { getDashboardWidget } from "../features/dashboard/registries/widgets";
  import DashboardWidgetFrame from "../features/dashboard/DashboardWidgetFrame.svelte";
  import DashboardViewBuilder from "../features/dashboard/DashboardViewBuilder.svelte";

  let { navigate, pageId }: { navigate: Navigate; pageId?: string } = $props();

  type DrawerState = { mode: "create" } | { mode: "edit"; view: DashboardViewDTO };

  let drawer = $state<DrawerState | null>(null);
  let tableTargets = $state<ReferenceTargetOption[]>([]);

  const systemTargets: ReferenceTargetOption[] = [
    { table: "workspace", label: "系统：工作区", displayKeys: [] },
    { table: "workbook", label: "系统：工作簿", displayKeys: [] },
    { table: "sheet", label: "系统：Sheet", displayKeys: [] },
    { table: "folder", label: "系统：目录", displayKeys: [] },
    { table: "app_user", label: "系统：用户", displayKeys: [] },
  ];

  const tableOptions = $derived(
    [...systemTargets, ...tableTargets.filter((t) => !systemTargets.some((s) => s.table === t.table))]
      .map((opt) => ({ table: opt.table, label: opt.label })),
  );

  $effect(() => {
    const workspaceId = appState.workspace?.id;
    const requested = pageId;
    untrack(() => {
      if (workspaceId) {
        void dashboardsStore.loadForWorkspace(workspaceId, requested);
        void loadReferenceTargets();
      }
    });
  });

  async function loadReferenceTargets() {
    const res = await appApi.listReferenceTargets();
    if (res.ok) {
      tableTargets = res.data.targets;
    }
  }

  function openCreate() {
    dashboardsStore.clearPreview();
    drawer = { mode: "create" };
  }

  function openEdit(view: DashboardViewDTO) {
    dashboardsStore.clearPreview();
    drawer = { mode: "edit", view };
  }

  function closeDrawer() {
    drawer = null;
    dashboardsStore.clearPreview();
  }

  async function createPage() {
    const next = await dashboardsStore.createPage(`概览 ${dashboardsStore.pages.length + 1}`);
    if (next) navigate("dashboard", { dashboardPageId: next.id });
  }

  async function switchPage(nextPageId: string) {
    await dashboardsStore.loadPage(nextPageId);
    navigate("dashboard", { dashboardPageId: nextPageId });
  }

  async function handleSubmit(draft: DashboardViewDraftDTO) {
    const page = dashboardsStore.activePage;
    if (!page || !drawer) return;

    if (drawer.mode === "edit") {
      const updated = await dashboardsStore.updateView(drawer.view.id, draft);
      if (updated) closeDrawer();
      return;
    }

    const index = page.widgets.length;
    const widget: Omit<DashboardWidgetLayoutDTO, "viewId"> = {
      id: `widget_${Date.now().toString(36)}`,
      titleOverride: draft.title.trim() || undefined,
      grid: {
        x: (index % 2) * 6,
        y: Math.floor(index / 2) * 2,
        w: 6,
        h: draft.viewType === "kpi" ? 1 : 2,
      },
    };
    const created = await dashboardsStore.createViewAndAttach(draft, widget);
    if (created) closeDrawer();
  }

  async function removeWidget(widgetId: string) {
    await dashboardsStore.removeWidget(widgetId);
  }
</script>

<section class="dashboard-screen">
  <aside class="dashboard-side">
    <div class="side-head">
      <div>
        <strong>仪表盘</strong>
        <span>{appState.workspace?.name ?? "当前工作区"}</span>
      </div>
      <button class="ghost-btn" onclick={createPage}>
        <Icon name="plus" size={14} />新建
      </button>
    </div>

    <div class="page-list">
      {#each dashboardsStore.pages as page (page.id)}
        <button
          class="page-link"
          class:active={dashboardsStore.activePageId === page.id}
          onclick={() => switchPage(page.id)}
        >
          <span>{page.title}</span>
          <small>{page.slug}</small>
        </button>
      {/each}
    </div>
  </aside>

  <div class="dashboard-main">
    <header class="toolbar">
      <div>
        <h1>{dashboardsStore.activePage?.title ?? "仪表盘"}</h1>
        <p>{dashboardsStore.activePage?.description ?? "本地只读统计视图"}</p>
      </div>

      <div class="toolbar-actions">
        <button class="secondary-btn" onclick={() => dashboardsStore.refreshPage()}>
          <Icon name="refresh" size={14} />刷新
        </button>
        <button class="primary-btn" onclick={openCreate}>
          <Icon name="plus" size={14} color="#fff" />添加视图
        </button>
      </div>
    </header>

    {#if dashboardsStore.error}
      <div class="state error">{dashboardsStore.error}</div>
    {:else if dashboardsStore.loading && !dashboardsStore.activePage}
      <div class="state">加载仪表盘…</div>
    {:else if !dashboardsStore.activePage}
      <div class="state">
        <EmptyState icon="coins" title="暂无仪表盘" desc="创建后即可添加统计视图。" />
      </div>
    {:else if dashboardsStore.activePage.widgets.length === 0}
      <div class="empty-board">
        <EmptyState icon="coins" title="添加首个视图" desc="从 Builder 选图表类型，或切到 SQL 直接写。" />
        <button class="primary-btn" onclick={openCreate}>
          <Icon name="plus" size={14} color="#fff" />添加视图
        </button>
      </div>
    {:else}
      <div class="widget-grid">
        {#each dashboardsStore.activePage.widgets as widget (widget.id)}
          {@const view = dashboardsStore.viewsById[widget.viewId]}
          {@const cache = dashboardsStore.cachesByViewId[widget.viewId]}
          {#if view}
            {@const registration = getDashboardWidget(view.viewType)}
            <div
              class="widget-cell"
              style={`grid-column: ${Math.max(1, widget.grid.x + 1)} / span ${Math.max(3, Math.min(widget.grid.w, 12))}; grid-row: ${Math.max(1, widget.grid.y + 1)} / span ${Math.max(1, widget.grid.h)}; min-height:${widget.grid.h === 1 ? 220 : 320}px;`}
            >
              <DashboardWidgetFrame
                title={widget.titleOverride || view.title}
                subtitle={cache?.executedAt ? `更新于 ${new Date(cache.executedAt).toLocaleString("zh-CN")}` : "尚未刷新"}
                onEdit={() => openEdit(view)}
                onRemove={() => removeWidget(widget.id)}
              >
                {#if registration}
                  {@const WidgetComponent = registration.component}
                  <WidgetComponent {view} {cache} />
                {:else}
                  <EmptyState icon="alertCircle" title="未知视图类型" desc={view.viewType} />
                {/if}
              </DashboardWidgetFrame>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  {#if drawer && appState.workspace?.id}
    <aside class="creator">
      <div class="creator-head">
        <strong>{drawer.mode === "edit" ? "编辑视图" : "添加视图"}</strong>
        <button class="ghost-btn" onclick={closeDrawer}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div class="creator-body">
        <DashboardViewBuilder
          workspaceId={appState.workspace.id}
          {tableOptions}
          initialView={drawer.mode === "edit" ? drawer.view : undefined}
          onSubmit={handleSubmit}
          onCancel={closeDrawer}
          saving={dashboardsStore.saving}
        />
      </div>
    </aside>
  {/if}
</section>

<style>
  .dashboard-screen {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    background:
      radial-gradient(circle at top left, rgba(22, 100, 255, .08), transparent 28%),
      linear-gradient(180deg, #f5f7fb 0%, #eef2f7 100%);
  }

  .dashboard-side {
    display: flex;
    width: 220px;
    flex-shrink: 0;
    flex-direction: column;
    gap: 16px;
    padding: 18px 16px;
    border-right: 1px solid rgba(229, 230, 235, .85);
    background: rgba(255, 255, 255, .84);
    backdrop-filter: blur(16px);
  }

  .side-head,
  .toolbar,
  .creator-head,
  .toolbar-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .side-head strong,
  .creator-head strong {
    display: block;
    color: var(--text-1);
    font-size: 14px;
  }

  .side-head span {
    color: var(--text-3);
    font-size: 11px;
  }

  .page-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .page-link {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px;
    border: 1px solid transparent;
    border-radius: 14px;
    background: transparent;
    color: var(--text-2);
    text-align: left;
    cursor: pointer;
  }

  .page-link.active {
    border-color: rgba(22, 100, 255, .18);
    background: rgba(22, 100, 255, .09);
    color: var(--primary);
  }

  .page-link small {
    color: var(--text-3);
    font-size: 11px;
  }

  .dashboard-main {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 18px;
    padding: 24px;
  }

  .toolbar h1 {
    margin: 0;
    color: var(--text-1);
    font-size: 24px;
  }

  .toolbar p {
    margin: 6px 0 0;
    color: var(--text-3);
    font-size: 12px;
  }

  .widget-grid {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 18px;
    overflow: auto;
  }

  .widget-cell {
    min-width: 0;
  }

  .creator {
    display: flex;
    width: 720px;
    flex-shrink: 0;
    flex-direction: column;
    border-left: 1px solid rgba(229, 230, 235, .85);
    background: rgba(255, 255, 255, .98);
    backdrop-filter: blur(16px);
  }

  .creator-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }

  .creator-body {
    display: flex;
    min-height: 0;
    flex: 1;
  }

  .state,
  .empty-board {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
  }

  .state.error {
    color: var(--error);
  }

  .empty-board {
    flex-direction: column;
    gap: 14px;
  }

  @media (max-width: 1280px) {
    .creator {
      width: 560px;
    }
  }

  @media (max-width: 1080px) {
    .creator {
      width: 100%;
      position: absolute;
      inset: 0;
      z-index: 30;
    }
  }
</style>
