<script lang="ts">
  import { AreaChart } from "layerchart";
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  type ChartRow = { x: string; y: number; series?: string };

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "rows" in cache.result && cache.result.rows[0] && "x" in cache.result.rows[0] ? cache.result : null);
  const rows = $derived<ChartRow[]>((result?.rows ?? []).map((row) => ({
    x: row.x,
    y: Number(row.y) || 0,
    series: row.series,
  })));
</script>

{#if rows.length > 0}
  <div class="chart-wrap">
    <AreaChart
      data={rows}
      x="x"
      y="y"
      z="series"
      padding={{ top: 16, right: 10, bottom: 36, left: 44 }}
      yDomain={[0, null]}
      yNice={true}
      grid={true}
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
