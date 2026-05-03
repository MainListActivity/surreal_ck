<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import { dashboardsStore } from "../../lib/dashboards.svelte";
  import { editorStore } from "../../lib/editor.svelte";
  import type {
    DashboardPageSummaryDTO,
    DashboardResultContract,
    DashboardViewDTO,
    DashboardViewDraftDTO,
    DashboardViewType,
    DashboardWidgetLayoutDTO,
    GridColumnDef,
    SheetSummaryDTO,
  } from "../../../shared/rpc.types";
  import DashboardWidgetFrame from "./DashboardWidgetFrame.svelte";
  import { getDashboardWidget } from "./registries/widgets";

  let showBuilder = $state(false);
  let chartType = $state<DashboardViewType>("bar");
  let sourceSheetId = $state("");
  let title = $state("");
  let metricOp = $state<"count" | "sum" | "avg" | "min" | "max">("count");
  let measureField = $state("");
  let dimensionField = $state("");
  let timeBucket = $state<"" | "day" | "week" | "month">("");
  let limit = $state(12);
  let tab = $state<"data" | "style">("data");

  const sourceSheet = $derived(editorStore.sheets.find((sheet) => sheet.id === sourceSheetId) ?? null);
  const fields = $derived(sourceSheet?.columnDefs ?? []);
  const categoryFields = $derived(fields.filter((field) => field.fieldType !== "reference"));
  const numericFields = $derived(fields.filter((field) => ["number", "currency"].includes(field.fieldType)));
  const dateFields = $derived(fields.filter((field) => field.fieldType === "date"));
  const previewView = $derived.by(() => {
    if (!dashboardsStore.preview) return null;
    const view = buildPreviewView();
    if (!view) return null;
    return {
      view,
      cache: {
        viewId: "__preview__",
        status: "ok",
        rowsCount: dashboardsStore.preview.rowsCount,
        durationMs: dashboardsStore.preview.durationMs,
        executedAt: new Date().toISOString(),
        sqlHash: dashboardsStore.preview.sqlHash,
        result: dashboardsStore.preview.result,
        resultMeta: dashboardsStore.preview.resultMeta,
      },
    };
  });

  $effect(() => {
    if (!sourceSheetId && editorStore.sheets.length > 0) {
      sourceSheetId = editorStore.activeSheetId ?? editorStore.sheets[0].id;
    }
  });

  $effect(() => {
    const columns = sourceSheet?.columnDefs ?? [];
    if (!columns.length) return;
    if (!dimensionField) {
      dimensionField = columns[0]?.key ?? "";
    }
    if (!measureField && numericFields.length > 0) {
      measureField = numericFields[0].key;
    }
    if ((chartType === "line" || chartType === "area") && !timeBucket && dateFields.length > 0) {
      dimensionField = dateFields[0].key;
      timeBucket = "day";
    }
  });

  function openBuilder() {
    dashboardsStore.clearPreview();
    title = "";
    chartType = "bar";
    metricOp = "count";
    timeBucket = "";
    showBuilder = true;
    tab = "data";
  }

  async function switchPage(pageId: string) {
    await dashboardsStore.loadPage(pageId);
  }

  function buildTitle(): string {
    const sheetName = sourceSheet?.label ?? "智能表";
    if (chartType === "kpi") return title.trim() || `${sheetName} 记录数`;
    if (chartType === "table") return title.trim() || `${sheetName} 明细表`;
    const dim = fields.find((field) => field.key === dimensionField)?.label ?? "分类";
    const metric = metricOp === "count"
      ? "数量"
      : `${fields.find((field) => field.key === measureField)?.label ?? "数值"}${metricOp === "sum" ? "汇总" : metricOp === "avg" ? "平均" : metricOp === "min" ? "最小" : "最大"}`;
    return title.trim() || `${sheetName} ${dim}${metric}`;
  }

  function buildDraft(): DashboardViewDraftDTO {
    const workbook = editorStore.data?.workbook;
    const sheet = sourceSheet;
    if (!workbook || !sheet) {
      throw new Error("workbook not ready");
    }

    if (chartType === "table") {
      return {
        workspaceId: workbook.workspaceId,
        workbookId: workbook.id,
        title: buildTitle(),
        queryMode: "sql",
        viewType: "table",
        resultContract: "table_rows",
        compiledSql: `SELECT id, * FROM ${sheet.tableName} LIMIT ${Math.max(1, Math.min(limit, 50))}`,
      };
    }

    const metric = metricOp === "count"
      ? { op: "count" as const }
      : { op: metricOp, field: measureField };

    if (chartType === "kpi") {
      return {
        workspaceId: workbook.workspaceId,
        workbookId: workbook.id,
        title: buildTitle(),
        queryMode: "builder",
        viewType: "kpi",
        resultContract: "single_value",
        builderSpec: {
          sourceTables: [sheet.tableName],
          baseTable: sheet.tableName,
          metric,
        },
      };
    }

    const bucket = (chartType === "line" || chartType === "area") ? (timeBucket || undefined) : undefined;
    const resultContract: DashboardResultContract =
      chartType === "line" || chartType === "area" ? "time_series" : "category_breakdown";

    return {
      workspaceId: workbook.workspaceId,
      workbookId: workbook.id,
      title: buildTitle(),
      queryMode: "builder",
      viewType: chartType,
      resultContract,
      builderSpec: {
        sourceTables: [sheet.tableName],
        baseTable: sheet.tableName,
        metric,
        dimensions: [{ field: dimensionField, bucket }],
        limit,
      },
    };
  }

  function buildPreviewView(): DashboardViewDTO | null {
    const workbook = editorStore.data?.workbook;
    if (!workbook) return null;
    try {
      const draft = buildDraft();
      return {
        id: "__preview__",
        workspaceId: workbook.workspaceId,
        workbookId: workbook.id,
        title: draft.title,
        slug: "preview",
        description: draft.description,
        queryMode: draft.queryMode,
        viewType: draft.viewType,
        resultContract: draft.resultContract,
        status: "active",
        compiledSql: dashboardsStore.preview?.sql ?? draft.compiledSql ?? "",
        builderSpec: draft.builderSpec,
        displaySpec: draft.displaySpec ?? {},
        sourceTables: dashboardsStore.preview?.sourceTables ?? [],
        dependencies: dashboardsStore.preview?.dependencies ?? [],
        version: 0,
      };
    } catch {
      return null;
    }
  }

  async function preview() {
    await dashboardsStore.previewView(buildDraft());
  }

  async function save() {
    const page = dashboardsStore.activePage;
    if (!page) return;
    const nextIndex = page.widgets.length;
    const widget: Omit<DashboardWidgetLayoutDTO, "viewId"> = {
      id: `widget_${Date.now().toString(36)}`,
      titleOverride: title.trim() || undefined,
      grid: {
        x: (nextIndex % 2) * 6,
        y: Math.floor(nextIndex / 2) * 2,
        w: 6,
        h: chartType === "kpi" ? 1 : 2,
      },
    };
    const created = await dashboardsStore.createViewAndAttach(buildDraft(), widget);
    if (created) {
      showBuilder = false;
    }
  }

  async function removeWidget(widgetId: string) {
    await dashboardsStore.removeWidget(widgetId);
  }

  function canSubmit() {
    if (!sourceSheet) return false;
    if (chartType === "table" || chartType === "kpi") return true;
    if (!dimensionField) return false;
    if (metricOp !== "count" && !measureField) return false;
    return true;
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
      <button class="primary-btn" onclick={openBuilder} disabled={!dashboardsStore.activePage}>
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

  {#if showBuilder}
    <div class="builder-mask" role="presentation" onclick={() => (showBuilder = false)}>
      <section class="builder-modal" role="dialog" aria-modal="true" onclick={(event) => event.stopPropagation()}>
        <aside class="builder-side">
          <div class="tab-row">
            <button class:active={tab === "data"} onclick={() => (tab = "data")}>数据信息</button>
            <button class:active={tab === "style"} onclick={() => (tab = "style")}>更多配置</button>
          </div>

          {#if tab === "data"}
            <div class="form-block">
              <label>图表类型</label>
              <div class="type-grid">
                {#each [
                  ["bar", "柱状图"],
                  ["line", "折线图"],
                  ["pie", "饼图"],
                  ["area", "面积图"],
                  ["kpi", "数字卡"],
                  ["table", "表格"],
                ] as [value, label]}
                  <button class:active={chartType === value} onclick={() => (chartType = value as DashboardViewType)}>{label}</button>
                {/each}
              </div>
            </div>

            <div class="form-block">
              <label>数据源智能表</label>
              <select bind:value={sourceSheetId}>
                {#each editorStore.sheets as sheet}
                  <option value={sheet.id}>{sheet.label}</option>
                {/each}
              </select>
            </div>

            <div class="form-block">
              <label>标题</label>
              <input bind:value={title} placeholder="留空将自动生成标题" />
            </div>

            {#if chartType !== "table"}
              <div class="form-block">
                <label>统计方式</label>
                <select bind:value={metricOp}>
                  <option value="count">计数</option>
                  <option value="sum">求和</option>
                  <option value="avg">平均值</option>
                  <option value="min">最小值</option>
                  <option value="max">最大值</option>
                </select>
              </div>
            {/if}

            {#if metricOp !== "count" && chartType !== "table"}
              <div class="form-block">
                <label>指标字段</label>
                <select bind:value={measureField}>
                  {#each numericFields as field}
                    <option value={field.key}>{field.label}</option>
                  {/each}
                </select>
              </div>
            {/if}

            {#if chartType !== "kpi" && chartType !== "table"}
              <div class="form-block">
                <label>{chartType === "line" || chartType === "area" ? "时间/类别字段" : "分类字段"}</label>
                <select bind:value={dimensionField}>
                  {#each categoryFields as field}
                    <option value={field.key}>{field.label}</option>
                  {/each}
                </select>
              </div>
            {/if}

            {#if chartType === "line" || chartType === "area"}
              <div class="form-block">
                <label>时间粒度</label>
                <select bind:value={timeBucket}>
                  <option value="">不分桶</option>
                  <option value="day">按天</option>
                  <option value="week">按周</option>
                  <option value="month">按月</option>
                </select>
              </div>
            {/if}

            <div class="form-block">
              <label>限制条数</label>
              <input type="number" bind:value={limit} min="1" max="50" />
            </div>
          {:else}
            <div class="style-note">
              第一阶段先固定品牌色、图例与标签样式。
              下一步再补主题色板、双轴、组合图和联动筛选。
            </div>
          {/if}

          <div class="builder-actions">
            <button class="secondary-btn" onclick={preview} disabled={!canSubmit() || dashboardsStore.saving}>
              预览
            </button>
            <button class="primary-btn" onclick={save} disabled={!canSubmit() || dashboardsStore.saving}>
              添加
            </button>
          </div>
        </aside>

        <div class="builder-preview">
          <div class="preview-head">
            <strong>{buildTitle()}</strong>
            <button class="icon-btn" onclick={() => (showBuilder = false)}>
              <Icon name="x" size={18} />
            </button>
          </div>

          {#if previewView}
            {@const registration = getDashboardWidget(previewView.view.viewType)}
            <div class="preview-card">
              {#if registration}
                {@const WidgetComponent = registration.component}
                <WidgetComponent view={previewView.view} cache={previewView.cache} />
              {/if}
            </div>
          {:else}
            <div class="preview-empty">
              <EmptyState icon="coins" title="点击预览" desc="左侧选择图表类型和数据源后即可生成预览。" />
            </div>
          {/if}
        </div>
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
    display: grid;
    grid-template-columns: 360px minmax(520px, 1fr);
    width: min(1440px, calc(100vw - 48px));
    height: min(860px, calc(100vh - 48px));
    border: 1px solid rgba(229, 230, 235, .8);
    border-radius: 24px;
    background: rgba(255, 255, 255, .98);
    overflow: hidden;
    box-shadow: 0 30px 90px rgba(15, 23, 42, .18);
  }

  .builder-side {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: #fbfcff;
  }

  .tab-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 12px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }

  .tab-row button {
    height: 42px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-2);
    font-weight: 600;
  }

  .tab-row button.active {
    background: rgba(22, 100, 255, .08);
    color: var(--primary);
  }

  .form-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px 0;
  }

  .form-block label {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }

  .form-block input,
  .form-block select {
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #fff;
  }

  .type-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .type-grid button {
    height: 40px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #fff;
    color: var(--text-2);
  }

  .type-grid button.active {
    border-color: rgba(22, 100, 255, .22);
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .style-note {
    padding: 20px 16px;
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.6;
  }

  .builder-actions {
    display: flex;
    gap: 10px;
    margin-top: auto;
    padding: 16px;
    border-top: 1px solid var(--border);
  }

  .builder-preview {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: #fff;
  }

  .preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
  }

  .preview-card,
  .preview-empty {
    min-height: 0;
    flex: 1;
    padding: 18px;
  }

  .preview-card {
    overflow: auto;
  }

  @media (max-width: 1180px) {
    .builder-modal {
      grid-template-columns: 320px minmax(0, 1fr);
      width: calc(100vw - 24px);
      height: calc(100vh - 24px);
    }
  }
</style>
