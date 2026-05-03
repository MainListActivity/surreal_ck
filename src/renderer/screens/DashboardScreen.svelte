<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import type { Navigate } from "../lib/types";
  import { appState } from "../lib/app-state.svelte";
  import { dashboardsStore } from "../lib/dashboards.svelte";
  import { appApi } from "../lib/app-api";
  import type {
    DashboardResultContract,
    DashboardViewDraftDTO,
    DashboardViewType,
    DashboardWidgetLayoutDTO,
    ReferenceTargetOption,
  } from "../../shared/rpc.types";
  import { dashboardBuilderTemplates } from "../features/dashboard/registries/builder-templates";
  import { getDashboardWidget } from "../features/dashboard/registries/widgets";
  import DashboardWidgetFrame from "../features/dashboard/DashboardWidgetFrame.svelte";

  let { navigate, pageId }: { navigate: Navigate; pageId?: string } = $props();

  let showCreator = $state(false);
  let templateId = $state("record_count");
  let title = $state("");
  let baseTable = $state("workbook");
  let dimensionField = $state("template_key");
  let sortField = $state("updated_at");
  let limit = $state(10);
  let sql = $state("SELECT id, name, updated_at FROM workbook ORDER BY updated_at DESC LIMIT 10");
  let viewType = $state<DashboardViewType>("table");
  let resultContract = $state<DashboardResultContract>("table_rows");
  let tableTargets = $state<ReferenceTargetOption[]>([]);

  const systemTargets = [
    { table: "workspace", label: "系统：工作区", displayKeys: [] },
    { table: "workbook", label: "系统：工作簿", displayKeys: [] },
    { table: "sheet", label: "系统：Sheet", displayKeys: [] },
    { table: "folder", label: "系统：目录", displayKeys: [] },
    { table: "app_user", label: "系统：用户", displayKeys: [] },
  ] satisfies ReferenceTargetOption[];

  const allTargets = $derived([
    ...systemTargets,
    ...tableTargets.filter((target) => !systemTargets.some((system) => system.table === target.table)),
  ]);

  const activeTemplate = $derived(
    dashboardBuilderTemplates.find((item) => item.id === templateId) ?? dashboardBuilderTemplates[0],
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

  function openCreator() {
    title = "";
    dimensionField = "template_key";
    sortField = "updated_at";
    limit = 10;
    sql = "SELECT id, name, updated_at FROM workbook ORDER BY updated_at DESC LIMIT 10";
    baseTable = "workbook";
    templateId = "record_count";
    viewType = "table";
    resultContract = "table_rows";
    dashboardsStore.clearPreview();
    showCreator = true;
  }

  async function createPage() {
    const next = await dashboardsStore.createPage(`概览 ${dashboardsStore.pages.length + 1}`);
    if (next) navigate("dashboard", { dashboardPageId: next.id });
  }

  async function switchPage(nextPageId: string) {
    await dashboardsStore.loadPage(nextPageId);
    navigate("dashboard", { dashboardPageId: nextPageId });
  }

  function buildDraft(): DashboardViewDraftDTO {
    const workspaceId = appState.workspace?.id;
    if (!workspaceId) {
      throw new Error("workspace not ready");
    }

    switch (activeTemplate.kind) {
      case "record_count":
        return {
          workspaceId,
          title: title.trim() || `${baseTable} 记录总数`,
          queryMode: "builder",
          viewType: "kpi",
          resultContract: "single_value",
          builderSpec: {
            sourceTables: [baseTable],
            baseTable,
            metric: { op: "count" },
          },
        };
      case "group_count":
        return {
          workspaceId,
          title: title.trim() || `${baseTable} 分类统计`,
          queryMode: "builder",
          viewType: "bar",
          resultContract: "category_breakdown",
          builderSpec: {
            sourceTables: [baseTable],
            baseTable,
            metric: { op: "count" },
            dimensions: [{ field: dimensionField.trim() || "template_key" }],
            limit,
          },
        };
      case "latest_rows":
        return {
          workspaceId,
          title: title.trim() || `${baseTable} 最近记录`,
          queryMode: "sql",
          viewType: "table",
          resultContract: "table_rows",
          compiledSql: `SELECT id, * FROM ${baseTable} ORDER BY ${sortField.trim() || "updated_at"} DESC LIMIT ${limit}`,
        };
      case "advanced_sql":
      default:
        return {
          workspaceId,
          title: title.trim() || "高级 SQL 视图",
          queryMode: "sql",
          viewType,
          resultContract,
          compiledSql: sql.trim(),
        };
    }
  }

  async function previewCurrentDraft() {
    await dashboardsStore.previewView(buildDraft());
  }

  async function saveCurrentDraft() {
    const page = dashboardsStore.activePage;
    if (!page) return;
    const index = page.widgets.length;
    const widget: Omit<DashboardWidgetLayoutDTO, "viewId"> = {
      id: `widget_${Date.now().toString(36)}`,
      titleOverride: title.trim() || undefined,
      grid: { x: (index % 2) * 6, y: Math.floor(index / 2) * 2, w: 6, h: activeTemplate.kind === "record_count" ? 1 : 2 },
    };
    const created = await dashboardsStore.createViewAndAttach(buildDraft(), widget);
    if (created) {
      showCreator = false;
    }
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
        <button class="primary-btn" onclick={openCreator}>
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
        <EmptyState icon="coins" title="添加首个视图" desc="从记录总数、分类计数或高级 SQL 开始。" />
        <button class="primary-btn" onclick={openCreator}>
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

  {#if showCreator}
    <aside class="creator">
      <div class="creator-head">
        <strong>添加视图</strong>
        <button class="ghost-btn" onclick={() => (showCreator = false)}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <label>
        <span>模板</span>
        <select bind:value={templateId}>
          {#each dashboardBuilderTemplates as template}
            <option value={template.id}>{template.label}</option>
          {/each}
        </select>
      </label>

      <label>
        <span>标题</span>
        <input bind:value={title} placeholder="例如：工作簿总数" />
      </label>

      <label>
        <span>数据表</span>
        <select bind:value={baseTable}>
          {#each allTargets as target}
            <option value={target.table}>{target.label}</option>
          {/each}
        </select>
      </label>

      {#if activeTemplate.kind === "group_count"}
        <label>
          <span>分组字段</span>
          <input bind:value={dimensionField} placeholder="例如：template_key" />
        </label>
      {/if}

      {#if activeTemplate.kind === "latest_rows"}
        <label>
          <span>排序字段</span>
          <input bind:value={sortField} placeholder="例如：updated_at" />
        </label>
      {/if}

      {#if activeTemplate.kind === "group_count" || activeTemplate.kind === "latest_rows"}
        <label>
          <span>LIMIT</span>
          <input type="number" min="1" max="100" bind:value={limit} />
        </label>
      {/if}

      {#if activeTemplate.kind === "advanced_sql"}
        <label>
          <span>视图类型</span>
          <select bind:value={viewType}>
            <option value="table">表格</option>
            <option value="kpi">KPI</option>
            <option value="bar">柱图</option>
            <option value="line">折线</option>
          </select>
        </label>

        <label>
          <span>结果契约</span>
          <select bind:value={resultContract}>
            <option value="table_rows">table_rows</option>
            <option value="single_value">single_value</option>
            <option value="category_breakdown">category_breakdown</option>
            <option value="time_series">time_series</option>
          </select>
        </label>

        <label class="full">
          <span>SQL</span>
          <textarea bind:value={sql} spellcheck="false"></textarea>
        </label>
      {/if}

      <div class="creator-actions">
        <button class="secondary-btn" onclick={previewCurrentDraft} disabled={dashboardsStore.saving}>
          <Icon name="eye" size={14} />预览
        </button>
        <button class="primary-btn" onclick={saveCurrentDraft} disabled={dashboardsStore.saving}>
          <Icon name="check" size={14} color="#fff" />保存
        </button>
      </div>

      {#if dashboardsStore.preview}
        <div class="preview-box">
          <strong>预览成功</strong>
          <span>{dashboardsStore.preview.sql}</span>
        </div>
      {/if}
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
  .toolbar-actions,
  .creator-actions {
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
    width: 360px;
    flex-shrink: 0;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    border-left: 1px solid rgba(229, 230, 235, .85);
    background: rgba(255, 255, 255, .95);
    backdrop-filter: blur(16px);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--text-2);
    font-size: 12px;
  }

  input,
  select,
  textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #fff;
    color: var(--text-1);
    font: inherit;
  }

  textarea {
    min-height: 180px;
    resize: vertical;
  }

  .preview-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: 12px;
    background: rgba(0, 180, 42, .08);
    color: var(--text-2);
    font-size: 12px;
  }

  .preview-box span {
    word-break: break-word;
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
</style>
