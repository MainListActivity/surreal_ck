<script lang="ts">
  import { BarChart } from "layerchart";
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  type ChartRow = { label: string; value: number };

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "rows" in cache.result && cache.result.rows[0] && "value" in cache.result.rows[0] ? cache.result : null);
  const rows = $derived<ChartRow[]>((result?.rows ?? []).map((row) => ({
    label: row.label,
    value: Number(row.value) || 0,
  })));
  const palette = ["#1664ff", "#4080ff", "#7bc6ff", "#69d1c5", "#36cfc9", "#73d13d"];
</script>

{#if rows.length > 0}
  <div class="chart-wrap">
    <BarChart
      data={rows}
      x="label"
      y="value"
      c="label"
      cRange={palette}
      yDomain={[0, null]}
      yNice={true}
      bandPadding={0.36}
      padding={{ top: 16, right: 8, bottom: 40, left: 44 }}
      tooltipContext={true}
      grid={{ y: true }}
      labels={true}
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
