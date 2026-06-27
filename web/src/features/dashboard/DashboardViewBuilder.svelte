<script lang="ts">
  import type { DashboardPreviewResponse, GridColumnDef } from "@surreal-ck/shared/rpc.types";
  import EmptyState from "../../components/EmptyState.svelte";
  import { X, Plus, AlertCircle, Coins } from "@lucide/svelte";
  import type { DashboardWidget } from "../../lib/dashboard-data";
  import { runDashboardWidgetQuery } from "../../lib/dashboard-query";
  import { getSurreal } from "../../lib/surreal";
  import {
    blankBuilderDraft,
    builderFieldOptions,
    draftFromWidget,
    specFromDraft,
    validateBuilderDraft,
    widgetFromDraft,
    type BuilderChartType,
    type BuilderFilterDraft,
  } from "./lib/dashboard-builder";
  import { getDashboardWidget } from "./registries/widgets";

  type TableOption = { table: string; label: string; columns: GridColumnDef[] };

  type Props = {
    /** 候选数据表（来源 editorStore.sheets）。 */
    tables: TableOption[];
    /** 当前页既有 widgets；新建时用于计算布局位置。 */
    existingWidgets: DashboardWidget[];
    /** 编辑模式：传入则按该 widget 回填表单。 */
    initialWidget?: DashboardWidget;
    saving?: boolean;
    onsubmit: (widget: DashboardWidget) => void | Promise<void>;
    oncancel: () => void;
  };

  let { tables, existingWidgets, initialWidget, saving = false, onsubmit, oncancel }: Props = $props();

  const CHART_TYPES: Array<[BuilderChartType, string]> = [
    ["bar", "柱状图"],
    ["line", "折线图"],
    ["pie", "饼图"],
    ["area", "面积图"],
    ["kpi", "数字卡"],
  ];

  const FILTER_OPS: Array<[BuilderFilterDraft["op"], string]> = [
    ["eq", "等于"],
    ["neq", "不等于"],
    ["gt", "大于"],
    ["gte", "大于等于"],
    ["lt", "小于"],
    ["lte", "小于等于"],
    ["contains", "包含"],
    ["in", "属于（逗号分隔）"],
    ["is_null", "为空"],
    ["is_not_null", "不为空"],
  ];

  // 刻意只取初值：modal 每次打开都重建本组件，表单生命周期内 props 不变。
  // svelte-ignore state_referenced_locally
  let draft = $state(
    initialWidget ? draftFromWidget(initialWidget) : blankBuilderDraft(tables[0]?.table ?? ""),
  );

  const currentTable = $derived(tables.find((option) => option.table === draft.baseTable));
  const fieldOptions = $derived(builderFieldOptions(currentTable?.columns ?? []));
  const metricFieldChoices = $derived(
    draft.metricOp === "count_distinct" ? fieldOptions.allFields : fieldOptions.numericFields,
  );
  const isTimeSeries = $derived(draft.chartType === "line" || draft.chartType === "area");
  const validationError = $derived(validateBuilderDraft(draft));

  // 只读预览：直连执行 D3-02 编译的聚合查询，绝无写语句。
  let preview = $state<DashboardPreviewResponse | null>(null);
  let previewError = $state<string | null>(null);
  let previewing = $state(false);

  const previewRegistration = $derived(getDashboardWidget(draft.chartType));

  /** 换表后字段下拉的旧选择可能已不存在；清掉失效项，预览作废。 */
  function handleTableChange() {
    const keys = new Set((currentTable?.columns ?? []).map((col) => col.key));
    if (draft.metricField && !keys.has(draft.metricField)) draft.metricField = "";
    if (draft.dimensionField && !keys.has(draft.dimensionField)) draft.dimensionField = "";
    draft.filters = draft.filters.filter((filter) => !filter.field || keys.has(filter.field));
    invalidatePreview();
  }

  function invalidatePreview() {
    preview = null;
    previewError = null;
  }

  function addFilter() {
    draft.filters = [...draft.filters, { field: "", op: "eq", value: "" }];
  }

  function removeFilter(index: number) {
    draft.filters = draft.filters.filter((_, i) => i !== index);
    invalidatePreview();
  }

  async function handlePreview() {
    if (validationError) return;
    previewing = true;
    previewError = null;
    try {
      preview = await runDashboardWidgetQuery(getSurreal(), {
        spec: specFromDraft(draft),
        viewType: draft.chartType,
      });
    } catch (err) {
      preview = null;
      previewError = err instanceof Error ? err.message : String(err);
    } finally {
      previewing = false;
    }
  }

  async function handleSubmit() {
    if (validationError || saving) return;
    await onsubmit(widgetFromDraft(draft, {
      widgets: existingWidgets,
      ...(initialWidget ? { existing: initialWidget } : {}),
      ...(currentTable ? { tableLabel: currentTable.label } : {}),
    }));
  }
</script>

<div class="builder-root">
  <aside class="builder-side">
    <div class="form-block">
      <label for="builder-title">标题</label>
      <input id="builder-title" bind:value={draft.title} placeholder="留空将自动生成标题" />
    </div>

    <div class="form-block">
      <span class="block-label">图表类型</span>
      <div class="type-grid">
        {#each CHART_TYPES as [value, label] (value)}
          <button
            type="button"
            class:active={draft.chartType === value}
            onclick={() => {
              draft.chartType = value;
              invalidatePreview();
            }}
          >
            {label}
          </button>
        {/each}
      </div>
    </div>

    <div class="form-block">
      <label for="builder-table">数据表</label>
      <select id="builder-table" bind:value={draft.baseTable} onchange={handleTableChange}>
        {#each tables as option (option.table)}
          <option value={option.table}>{option.label}</option>
        {/each}
      </select>
      {#if tables.length === 0}
        <small>工作簿暂无可用数据表</small>
      {/if}
    </div>

    <div class="form-block">
      <label for="builder-metric-op">统计方式</label>
      <select id="builder-metric-op" bind:value={draft.metricOp} onchange={invalidatePreview}>
        <option value="count">计数</option>
        <option value="count_distinct">去重计数</option>
        <option value="sum">求和</option>
        <option value="avg">平均值</option>
        <option value="min">最小值</option>
        <option value="max">最大值</option>
      </select>
    </div>

    {#if draft.metricOp !== "count"}
      <div class="form-block">
        <label for="builder-metric-field">指标字段</label>
        <select id="builder-metric-field" bind:value={draft.metricField} onchange={invalidatePreview}>
          <option value="">请选择</option>
          {#each metricFieldChoices as field (field.key)}
            <option value={field.key}>{field.label}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if draft.chartType !== "kpi"}
      <div class="form-block">
        <label for="builder-dimension">{isTimeSeries ? "时间/类别字段" : "分组字段"}</label>
        <select id="builder-dimension" bind:value={draft.dimensionField} onchange={invalidatePreview}>
          <option value="">请选择</option>
          {#each fieldOptions.dimensionFields as field (field.key)}
            <option value={field.key}>{field.label}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if isTimeSeries}
      <div class="form-block">
        <label for="builder-bucket">时间粒度</label>
        <select id="builder-bucket" bind:value={draft.timeBucket} onchange={invalidatePreview}>
          <option value="">不分桶</option>
          <option value="day">按天</option>
          <option value="week">按周</option>
          <option value="month">按月</option>
          <option value="year">按年</option>
        </select>
        {#if draft.timeBucket && fieldOptions.dateFields.every((field) => field.key !== draft.dimensionField)}
          <small>提示：时间分桶要求所选字段为日期类型</small>
        {/if}
      </div>
    {/if}

    <div class="form-block">
      <span class="block-label">筛选</span>
      {#each draft.filters as filter, index (index)}
        <div class="filter-row">
          <select bind:value={filter.field} onchange={invalidatePreview}>
            <option value="">字段</option>
            {#each fieldOptions.allFields as field (field.key)}
              <option value={field.key}>{field.label}</option>
            {/each}
          </select>
          <select bind:value={filter.op} onchange={invalidatePreview}>
            {#each FILTER_OPS as [value, label] (value)}
              <option {value}>{label}</option>
            {/each}
          </select>
          {#if filter.op !== "is_null" && filter.op !== "is_not_null"}
            <input bind:value={filter.value} placeholder="值" oninput={invalidatePreview} />
          {/if}
          <button type="button" class="icon-btn" title="移除筛选" onclick={() => removeFilter(index)}>
            <X size={14} />
          </button>
        </div>
      {/each}
      <button type="button" class="add-filter" onclick={addFilter}>
        <Plus size={13} />添加筛选
      </button>
    </div>

    {#if draft.chartType !== "kpi"}
      <div class="form-block">
        <label for="builder-limit">限制条数</label>
        <input id="builder-limit" type="number" bind:value={draft.limit} min="1" max="200" onchange={invalidatePreview} />
      </div>
    {/if}

    {#if validationError}
      <div class="form-block">
        <small class="error">{validationError}</small>
      </div>
    {/if}

    <div class="builder-actions">
      <button type="button" class="ghost" onclick={oncancel}>取消</button>
      <button type="button" class="secondary" onclick={handlePreview} disabled={!!validationError || previewing}>
        {previewing ? "执行中…" : "预览"}
      </button>
      <button type="button" class="primary" onclick={handleSubmit} disabled={!!validationError || saving}>
        {initialWidget ? "保存" : "添加"}
      </button>
    </div>
  </aside>

  <div class="builder-preview">
    <div class="preview-head">
      <strong>{draft.title.trim() || "预览"}</strong>
      {#if preview}
        <span class="preview-meta">{preview.rowsCount} 行 · {preview.durationMs}ms</span>
      {/if}
    </div>
    {#if previewError}
      <div class="preview-empty">
        <EmptyState icon={AlertCircle} title="预览失败" desc={previewError} />
      </div>
    {:else if preview && previewRegistration}
      {@const WidgetComponent = previewRegistration.component}
      <div class="preview-card">
        <WidgetComponent title={draft.title.trim() || "预览"} result={preview.result} />
      </div>
    {:else}
      <div class="preview-empty">
        <EmptyState icon={Coins} title="点击预览" desc="左侧配置完成后，点击「预览」直连执行只读聚合。" />
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
    background: var(--surface);
  }

  .form-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px 0;
  }

  .form-block label,
  .block-label {
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

  .type-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .type-grid button {
    height: 38px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }

  .type-grid button.active {
    border-color: var(--primary);
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .filter-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 28px;
    gap: 6px;
    align-items: center;
  }

  .filter-row select,
  .filter-row input {
    height: 32px;
    min-width: 0;
    padding: 0 8px;
    font-size: 12px;
  }

  .icon-btn {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .icon-btn:hover {
    background: var(--soft);
    color: var(--text-1);
  }

  .add-filter {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
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
    border-color: var(--primary);
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
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 14px;
  }

  .preview-meta {
    color: var(--text-3);
    font-size: 11px;
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

  .preview-card :global(> *) {
    flex: 1;
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
