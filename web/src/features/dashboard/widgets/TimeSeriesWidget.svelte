<script lang="ts">
  import { LineChart } from "layerchart";
  import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
  import { toTimeSeriesChartModel } from "./model";

  let { result }: { title: string; result?: DashboardNormalizedResult; displaySpec?: Record<string, unknown> } = $props();

  const model = $derived(toTimeSeriesChartModel(result));
</script>

{#if model.rows.length > 0}
  <div class="chart-wrap">
    <LineChart
      data={model.rows}
      x="x"
      y="y"
      z="series"
      padding={{ top: 16, right: 10, bottom: 36, left: 44 }}
      yDomain={[0, null]}
      yNice={true}
      grid={true}
      points={true}
      tooltipContext={true}
      height={240}
    />
  </div>
{:else}
  <div class="empty">{model.emptyText}</div>
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
