<script lang="ts">
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "value" in cache.result ? cache.result : null);
</script>

<div class="kpi-card">
  <div class="kpi-label">{view.displaySpec?.metricLabel ?? result?.label ?? view.title}</div>
  <div class="kpi-value">
    {#if result}
      {result.value ?? "—"}
    {:else}
      —
    {/if}
  </div>
  {#if result?.unit}
    <div class="kpi-unit">{result.unit}</div>
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
