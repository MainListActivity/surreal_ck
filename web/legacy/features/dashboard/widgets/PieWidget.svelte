<script lang="ts">
  import { PieChart } from "layerchart";
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  type ChartRow = { key: string; label: string; value: number };

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "rows" in cache.result && cache.result.rows[0] && "value" in cache.result.rows[0] ? cache.result : null);
  const rows = $derived<ChartRow[]>((result?.rows ?? []).map((row) => ({
    key: row.key,
    label: row.label,
    value: Number(row.value) || 0,
  })));
  const palette = ["#1664ff", "#14c9c9", "#73d13d", "#ffbb33", "#ff7d00", "#722ed1"];
</script>

{#if rows.length > 0}
  <div class="chart-wrap">
    <PieChart
      data={rows}
      key="key"
      label="label"
      value="value"
      c="label"
      cRange={palette}
      legend={true}
      labels={true}
      innerRadius={0.58}
      padding={12}
      tooltipContext={true}
      height={240}
    />
  </div>
{:else}
  <div class="empty">暂无数据</div>
{/if}

<style>
  .chart-wrap {
    height: 100%;
    min-height: 220px;
  }

  .empty {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 12px;
  }
</style>
