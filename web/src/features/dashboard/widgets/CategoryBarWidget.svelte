<script lang="ts">
  import { BarChart } from "layerchart";
  import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
  import { toCategoryChartModel } from "./model";

  let { result }: { title: string; result?: DashboardNormalizedResult; displaySpec?: Record<string, unknown> } = $props();

  const model = $derived(toCategoryChartModel(result));
  const palette = ["#1664ff", "#4080ff", "#7bc6ff", "#69d1c5", "#36cfc9", "#73d13d"];
</script>

{#if model.rows.length > 0}
  <div class="chart-wrap">
    <BarChart
      data={model.rows}
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
