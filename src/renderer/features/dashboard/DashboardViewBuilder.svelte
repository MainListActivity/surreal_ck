<script lang="ts">
  import { untrack } from "svelte";
  import EmptyState from "../../components/EmptyState.svelte";
  import { appApi } from "../../lib/app-api";
  import { dashboardsStore } from "../../lib/dashboards.svelte";
  import { getDashboardWidget } from "./registries/widgets";
  import type {
    DashboardBuilderMetricOp,
    DashboardResultContract,
    DashboardViewDTO,
    DashboardViewDraftDTO,
    DashboardViewType,
    TableSchemaField,
  } from "../../../shared/rpc.types";

  type TableOption = { table: string; label: string };

  type Props = {
    workspaceId: string;
    workbookId?: string;
    tableOptions: TableOption[];
    /** 编辑模式：传入则按该 view 初始化表单；否则空白新建。 */
    initialView?: DashboardViewDTO;
    onSubmit: (draft: DashboardViewDraftDTO) => Promise<void>;
    onCancel: () => void;
    /** 是否禁用提交按钮（外部 saving 状态）。 */
    saving?: boolean;
  };

  let { workspaceId, workbookId, tableOptions, initialView, onSubmit, onCancel, saving = false }: Props = $props();

  type Tab = "builder" | "sql";

  // ─── 表单状态 ────────────────────────────────────────────────────────────
  let tab = $state<Tab>("builder");
  let title = $state("");
  let chartType = $state<DashboardViewType>("bar");
  let sourceTable = $state("");
  let metricOp = $state<DashboardBuilderMetricOp>("count");
  let measureField = $state("");
  let dimensionField = $state("");
  let timeBucket = $state<"" | "day" | "week" | "month" | "year">("");
  let limit = $state(12);

  let sqlText = $state("");
  let sqlViewType = $state<DashboardViewType>("table");
  let sqlContract = $state<DashboardResultContract>("table_rows");

  // 字段元数据缓存：table → fields
  let fieldsByTable = $state<Record<string, TableSchemaField[]>>({});
  let fieldsLoading = $state(false);
  let fieldsError = $state<string | null>(null);

  const currentFields = $derived<TableSchemaField[]>(fieldsByTable[sourceTable] ?? []);
  const numericFields = $derived(currentFields.filter((f) => f.fieldType === "number" || f.fieldType === "currency"));
  const dateFields = $derived(currentFields.filter((f) => f.fieldType === "date"));
  const categoryFields = $derived(
    currentFields.filter((f) => f.fieldType !== "reference" && f.fieldType !== "json" && f.fieldType !== "unknown" && f.key !== "id"),
  );

  // ─── 初始化（编辑或新建） ────────────────────────────────────────────────
  $effect(() => {
    if (initialView) {
      hydrateFromView(initialView);
    } else {
      hydrateBlank();
    }
  });

  function hydrateBlank() {
    untrack(() => {
      tab = "builder";
      title = "";
      chartType = "bar";
      sourceTable = tableOptions[0]?.table ?? "";
      metricOp = "count";
      measureField = "";
      dimensionField = "";
      timeBucket = "";
      limit = 12;
      sqlText = "";
      sqlViewType = "table";
      sqlContract = "table_rows";
    });
  }

  function hydrateFromView(view: DashboardViewDTO) {
    untrack(() => {
      title = view.title;
      tab = view.queryMode === "sql" ? "sql" : "builder";
      sqlText = view.compiledSql ?? "";
      sqlViewType = view.viewType;
      sqlContract = view.resultContract;

      const spec = view.builderSpec;
      if (spec) {
        sourceTable = spec.baseTable;
        metricOp = spec.metric.op;
        measureField = spec.metric.field ?? "";
        dimensionField = spec.dimensions?.[0]?.field ?? "";
        timeBucket = spec.dimensions?.[0]?.bucket ?? "";
        limit = spec.limit ?? 12;
        chartType = view.viewType;
      } else {
        sourceTable = tableOptions[0]?.table ?? "";
        chartType = view.viewType;
      }
    });
  }

  // ─── 字段元数据按需加载 ──────────────────────────────────────────────────
  $effect(() => {
    const t = sourceTable;
    if (!t) return;
    if (fieldsByTable[t]) return;
    untrack(() => loadFields(t));
  });

  async function loadFields(table: string) {
    fieldsLoading = true;
    fieldsError = null;
    try {
      const res = await appApi.getTableSchema(table);
      if (!res.ok) {
        fieldsError = res.message;
        return;
      }
      fieldsByTable = { ...fieldsByTable, [table]: res.data.fields };
    } catch (err) {
      fieldsError = String(err);
    } finally {
      fieldsLoading = false;
    }
  }

  // ─── 自动填充默认字段（仅新建态） ───────────────────────────────────────
  $effect(() => {
    if (initialView) return;
    const fields = currentFields;
    if (fields.length === 0) return;
    untrack(() => {
      if (!dimensionField) {
        const firstCategory = fields.find((f) => f.fieldType !== "reference" && f.fieldType !== "json" && f.key !== "id");
        if (firstCategory) dimensionField = firstCategory.key;
      }
      if (!measureField && numericFields.length > 0) {
        measureField = numericFields[0].key;
      }
      if ((chartType === "line" || chartType === "area") && !timeBucket && dateFields.length > 0) {
        dimensionField = dateFields[0].key;
        timeBucket = "day";
      }
    });
  });

  // ─── 构造 draft ──────────────────────────────────────────────────────────
  function buildDraft(): DashboardViewDraftDTO {
    if (tab === "sql") {
      const trimmed = sqlText.trim();
      if (!trimmed) throw new Error("SQL 不能为空");
      return {
        workspaceId,
        workbookId,
        title: title.trim() || "未命名 SQL 视图",
        queryMode: "sql",
        viewType: sqlViewType,
        resultContract: sqlContract,
        compiledSql: trimmed,
      };
    }

    if (!sourceTable) throw new Error("请选择数据表");

    if (chartType === "table") {
      return {
        workspaceId,
        workbookId,
        title: title.trim() || `${labelOfTable(sourceTable)} 明细`,
        queryMode: "sql",
        viewType: "table",
        resultContract: "table_rows",
        compiledSql: `SELECT id, * FROM ${sourceTable} LIMIT ${Math.max(1, Math.min(limit, 50))}`,
      };
    }

    const metric = metricOp === "count"
      ? { op: "count" as const }
      : { op: metricOp, field: measureField };

    if (chartType === "kpi") {
      return {
        workspaceId,
        workbookId,
        title: title.trim() || `${labelOfTable(sourceTable)} ${metricLabel()}`,
        queryMode: "builder",
        viewType: "kpi",
        resultContract: "single_value",
        builderSpec: {
          sourceTables: [sourceTable],
          baseTable: sourceTable,
          metric,
        },
      };
    }

    const isTimeSeries = chartType === "line" || chartType === "area";
    const bucket = isTimeSeries ? (timeBucket || undefined) : undefined;
    const resultContract: DashboardResultContract = isTimeSeries ? "time_series" : "category_breakdown";

    return {
      workspaceId,
      workbookId,
      title: title.trim() || autoTitle(),
      queryMode: "builder",
      viewType: chartType,
      resultContract,
      builderSpec: {
        sourceTables: [sourceTable],
        baseTable: sourceTable,
        metric,
        dimensions: [{ field: dimensionField, bucket }],
        limit,
      },
    };
  }

  function labelOfTable(table: string): string {
    return tableOptions.find((opt) => opt.table === table)?.label ?? table;
  }

  function metricLabel(): string {
    if (metricOp === "count") return "记录数";
    const fieldLabel = currentFields.find((f) => f.key === measureField)?.label ?? measureField;
    const opLabel = { sum: "汇总", avg: "平均", min: "最小", max: "最大", count_distinct: "去重数" }[metricOp];
    return `${fieldLabel} ${opLabel}`;
  }

  function autoTitle(): string {
    const dimLabel = currentFields.find((f) => f.key === dimensionField)?.label ?? dimensionField;
    return `${labelOfTable(sourceTable)} ${dimLabel} ${metricLabel()}`;
  }

  function canSubmit(): boolean {
    if (saving) return false;
    if (tab === "sql") return sqlText.trim().length > 0;
    if (!sourceTable) return false;
    if (chartType === "table" || chartType === "kpi") {
      if (chartType === "kpi" && metricOp !== "count" && !measureField) return false;
      return true;
    }
    if (!dimensionField) return false;
    if (metricOp !== "count" && !measureField) return false;
    return true;
  }

  // ─── Tab 切换 ────────────────────────────────────────────────────────────
  let switchingTab = $state(false);

  async function switchToSql() {
    if (tab === "sql") return;
    // 把当前 builder 编译成 SQL 填进去，让用户基于此修改
    if (sourceTable) {
      switchingTab = true;
      try {
        const draft = buildDraft();
        if (draft.queryMode === "builder") {
          const res = await appApi.previewDashboardView(draft);
          if (res.ok) {
            sqlText = res.data.sql;
            sqlViewType = chartType;
            sqlContract = inferContract(chartType);
          } else {
            sqlText = `-- 预编译失败：${res.message}\n-- 你可以从这里手写 SQL`;
          }
        } else if (draft.compiledSql) {
          sqlText = draft.compiledSql;
          sqlViewType = draft.viewType;
          sqlContract = draft.resultContract;
        }
      } catch (err) {
        sqlText = `-- 预编译异常：${String(err)}\n-- 你可以从这里手写 SQL`;
      } finally {
        switchingTab = false;
      }
    }
    tab = "sql";
  }

  function switchToBuilder() {
    if (tab === "builder") return;
    const ok = window.confirm("切换到 Builder 将丢弃当前 SQL 修改，是否继续？");
    if (!ok) return;
    tab = "builder";
  }

  function inferContract(view: DashboardViewType): DashboardResultContract {
    switch (view) {
      case "kpi": return "single_value";
      case "table": return "table_rows";
      case "line":
      case "area": return "time_series";
      default: return "category_breakdown";
    }
  }

  // ─── 预览 ────────────────────────────────────────────────────────────────
  const previewView = $derived.by(() => {
    if (!dashboardsStore.preview) return null;
    let draft: DashboardViewDraftDTO;
    try {
      draft = buildDraft();
    } catch {
      return null;
    }
    return {
      view: {
        id: "__preview__",
        workspaceId,
        workbookId,
        title: draft.title,
        slug: "preview",
        queryMode: draft.queryMode,
        viewType: draft.viewType,
        resultContract: draft.resultContract,
        status: "active" as const,
        compiledSql: dashboardsStore.preview.sql,
        builderSpec: draft.builderSpec,
        displaySpec: draft.displaySpec ?? {},
        sourceTables: dashboardsStore.preview.sourceTables,
        dependencies: dashboardsStore.preview.dependencies,
        version: 0,
      } satisfies DashboardViewDTO,
      cache: {
        viewId: "__preview__",
        status: "ok" as const,
        rowsCount: dashboardsStore.preview.rowsCount,
        durationMs: dashboardsStore.preview.durationMs,
        executedAt: new Date().toISOString(),
        sqlHash: dashboardsStore.preview.sqlHash,
        result: dashboardsStore.preview.result,
        resultMeta: dashboardsStore.preview.resultMeta,
      },
    };
  });

  async function handlePreview() {
    try {
      const draft = buildDraft();
      await dashboardsStore.previewView(draft);
    } catch (err) {
      fieldsError = String(err);
    }
  }

  async function handleSubmit() {
    try {
      const draft = buildDraft();
      await onSubmit(draft);
    } catch (err) {
      fieldsError = String(err);
    }
  }
</script>

<div class="builder-root">
  <aside class="builder-side">
    <div class="tab-row">
      <button class:active={tab === "builder"} onclick={switchToBuilder} disabled={switchingTab}>Builder</button>
      <button class:active={tab === "sql"} onclick={switchToSql} disabled={switchingTab}>SQL</button>
    </div>

    <div class="form-block">
      <label for="title-input">标题</label>
      <input id="title-input" bind:value={title} placeholder="留空将自动生成标题" />
    </div>

    {#if tab === "builder"}
      <div class="form-block">
        <label for="chart-type">图表类型</label>
        <div id="chart-type" class="type-grid">
          {#each [
            ["bar", "柱状图"],
            ["line", "折线图"],
            ["pie", "饼图"],
            ["area", "面积图"],
            ["kpi", "数字卡"],
            ["table", "表格"],
          ] as [value, label]}
            <button
              type="button"
              class:active={chartType === value}
              onclick={() => (chartType = value as DashboardViewType)}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>

      <div class="form-block">
        <label for="source-table">数据表</label>
        <select id="source-table" bind:value={sourceTable}>
          {#each tableOptions as opt}
            <option value={opt.table}>{opt.label}</option>
          {/each}
        </select>
        {#if fieldsLoading}
          <small>加载字段中…</small>
        {:else if fieldsError}
          <small class="error">{fieldsError}</small>
        {:else if currentFields.length === 0 && sourceTable}
          <small>该表没有可用字段</small>
        {/if}
      </div>

      {#if chartType !== "table"}
        <div class="form-block">
          <label for="metric-op">统计方式</label>
          <select id="metric-op" bind:value={metricOp}>
            <option value="count">计数</option>
            <option value="count_distinct">去重计数</option>
            <option value="sum">求和</option>
            <option value="avg">平均值</option>
            <option value="min">最小值</option>
            <option value="max">最大值</option>
          </select>
        </div>
      {/if}

      {#if metricOp !== "count" && chartType !== "table"}
        <div class="form-block">
          <label for="measure-field">指标字段</label>
          <select id="measure-field" bind:value={measureField}>
            {#each (metricOp === "count_distinct" ? currentFields : numericFields) as field}
              <option value={field.key}>{field.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if chartType !== "kpi" && chartType !== "table"}
        <div class="form-block">
          <label for="dimension-field">{chartType === "line" || chartType === "area" ? "时间/类别字段" : "分类字段"}</label>
          <select id="dimension-field" bind:value={dimensionField}>
            {#each categoryFields as field}
              <option value={field.key}>{field.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if chartType === "line" || chartType === "area"}
        <div class="form-block">
          <label for="time-bucket">时间粒度</label>
          <select id="time-bucket" bind:value={timeBucket}>
            <option value="">不分桶</option>
            <option value="day">按天</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
            <option value="year">按年</option>
          </select>
        </div>
      {/if}

      {#if chartType !== "kpi"}
        <div class="form-block">
          <label for="limit-input">限制条数</label>
          <input id="limit-input" type="number" bind:value={limit} min="1" max="200" />
        </div>
      {/if}
    {:else}
      <div class="form-block">
        <label for="sql-view-type">视图类型</label>
        <select id="sql-view-type" bind:value={sqlViewType}>
          <option value="table">表格</option>
          <option value="kpi">数字卡</option>
          <option value="bar">柱图</option>
          <option value="line">折线</option>
          <option value="area">面积</option>
          <option value="pie">饼图</option>
        </select>
      </div>

      <div class="form-block">
        <label for="sql-contract">结果契约</label>
        <select id="sql-contract" bind:value={sqlContract}>
          <option value="table_rows">table_rows</option>
          <option value="single_value">single_value</option>
          <option value="category_breakdown">category_breakdown</option>
          <option value="time_series">time_series</option>
        </select>
      </div>

      <div class="form-block sql-block">
        <label for="sql-text">SQL</label>
        <textarea id="sql-text" bind:value={sqlText} spellcheck="false" placeholder="SELECT ..."></textarea>
      </div>
    {/if}

    <div class="builder-actions">
      <button type="button" class="ghost" onclick={onCancel}>取消</button>
      <button type="button" class="secondary" onclick={handlePreview} disabled={!canSubmit()}>预览</button>
      <button type="button" class="primary" onclick={handleSubmit} disabled={!canSubmit()}>
        {initialView ? "保存" : "添加"}
      </button>
    </div>
  </aside>

  <div class="builder-preview">
    <div class="preview-head">
      <strong>{title.trim() || (tab === "sql" ? "SQL 视图" : "Builder 视图")}</strong>
    </div>
    {#if previewView}
      {@const registration = getDashboardWidget(previewView.view.viewType)}
      <div class="preview-card">
        {#if registration}
          {@const WidgetComponent = registration.component}
          <WidgetComponent view={previewView.view} cache={previewView.cache} />
        {:else}
          <EmptyState icon="alertCircle" title="未知视图类型" desc={previewView.view.viewType} />
        {/if}
      </div>
    {:else}
      <div class="preview-empty">
        <EmptyState icon="coins" title="点击预览" desc="左侧配置完成后，点击「预览」生成图表。" />
      </div>
    {/if}
  </div>
</div>

<style>
  .builder-root {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    grid-template-columns: 360px minmax(360px, 1fr);
  }

  .builder-side {
    display: flex;
    min-height: 0;
    flex-direction: column;
    overflow-y: auto;
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
    height: 38px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-2);
    font-weight: 600;
    cursor: pointer;
  }

  .tab-row button.active {
    background: rgba(22, 100, 255, .08);
    color: var(--primary);
  }

  .tab-row button:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .form-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px 0;
  }

  .form-block label {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
  }

  .form-block small {
    color: var(--text-3);
    font-size: 11px;
  }

  .form-block small.error {
    color: var(--error);
  }

  .form-block input,
  .form-block select {
    height: 38px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text-1);
    font: inherit;
  }

  .sql-block {
    flex: 1;
    min-height: 200px;
  }

  .sql-block textarea {
    min-height: 200px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text-1);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
  }

  .type-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .type-grid button {
    height: 38px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text-2);
    cursor: pointer;
  }

  .type-grid button.active {
    border-color: rgba(22, 100, 255, .22);
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .builder-actions {
    display: flex;
    gap: 10px;
    margin-top: auto;
    padding: 16px;
    border-top: 1px solid var(--border);
  }

  .builder-actions button {
    height: 38px;
    flex: 1;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    color: var(--text-2);
    font-weight: 600;
    cursor: pointer;
  }

  .builder-actions button.primary {
    border-color: var(--primary);
    background: var(--primary);
    color: #fff;
  }

  .builder-actions button.secondary {
    border-color: rgba(22, 100, 255, .22);
    background: var(--primary-light);
    color: var(--primary);
  }

  .builder-actions button.ghost {
    background: transparent;
  }

  .builder-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .builder-preview {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    background: #fff;
  }

  .preview-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 14px;
  }

  .preview-card,
  .preview-empty {
    display: flex;
    min-height: 0;
    flex: 1;
    padding: 16px;
  }

  .preview-card {
    overflow: auto;
  }

  .preview-empty {
    align-items: center;
    justify-content: center;
  }

  @media (max-width: 1080px) {
    .builder-root {
      grid-template-columns: 320px minmax(0, 1fr);
    }
  }
</style>
