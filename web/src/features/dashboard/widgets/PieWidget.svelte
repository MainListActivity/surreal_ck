<script lang="ts">
  import { PieChart } from "layerchart";
  import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
  import { toPieChartModel } from "./model";

  let { result }: { title: string; result?: DashboardNormalizedResult; displaySpec?: Record<string, unknown> } = $props();

  const model = $derived(toPieChartModel(result));
  const palette = ["#1664ff", "#14c9c9", "#73d13d", "#ffbb33", "#ff7d00", "#722ed1"];
</script>

{#if model.rows.length > 0}
  <div class="pie-layout">
    <div class="chart-wrap">
      <PieChart
        data={model.rows}
        key="key"
        label="label"
        value="value"
        c="label"
        cRange={palette}
        legend={false}
        labels={true}
        innerRadius={0.58}
        padding={12}
        tooltipContext={true}
        height={220}
      />
    </div>
    <ul class="legend" aria-label="饼图占比">
      {#each model.rows as row}
        <li>
          <span>{row.label}</span>
          <strong>{row.shareLabel}</strong>
        </li>
      {/each}
    </ul>
  </div>
{:else}
  <div class="empty">{model.emptyText}</div>
{/if}

<style>
  .pie-layout {
    display: grid;
    height: 100%;
    min-height: 220px;
    grid-template-columns: minmax(0, 1fr) minmax(120px, .45fr);
    gap: 12px;
    align-items: center;
  }

  .chart-wrap {
    min-height: 220px;
  }

  .legend {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-2);
    font-size: 12px;
  }

  .legend li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }

  .legend span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .legend strong {
    color: var(--text-1);
    font-weight: 600;
  }

  .empty {
    display: flex;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .pie-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
