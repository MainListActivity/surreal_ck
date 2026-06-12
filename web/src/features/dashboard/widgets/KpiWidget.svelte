<script lang="ts">
  import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
  import { toKpiWidgetModel } from "./model";

  let {
    title,
    result,
    displaySpec,
  }: {
    title: string;
    result?: DashboardNormalizedResult;
    displaySpec?: Record<string, unknown>;
  } = $props();

  const model = $derived(toKpiWidgetModel(result, { title, displaySpec }));
</script>

<div class="kpi-card">
  <div class="kpi-label">{model.label}</div>
  <div class="kpi-value">{model.value}</div>
  {#if model.unit}
    <div class="kpi-unit">{model.unit}</div>
  {/if}
</div>

<style>
  .kpi-card {
    display: flex;
    height: 100%;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
    padding: 8px 2px;
  }

  .kpi-label {
    color: var(--text-3);
    font-size: 12px;
    letter-spacing: .04em;
  }

  .kpi-value {
    color: var(--text-1);
    font-size: clamp(30px, 4vw, 44px);
    font-weight: 700;
    line-height: 1;
  }

  .kpi-unit {
    color: var(--text-2);
    font-size: 12px;
  }
</style>
