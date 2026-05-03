<script lang="ts">
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "rows" in cache.result && cache.result.rows[0] && "value" in cache.result.rows[0] ? cache.result : null);
  const maxValue = $derived(result ? Math.max(...result.rows.map((row) => Number(row.value) || 0), 1) : 1);
</script>

{#if result}
  <div class="bars">
    {#each result.rows as row}
      <div class="bar-row">
        <div class="bar-head">
          <span class="label">{row.label}</span>
          <span class="value">{row.value}</span>
        </div>
        <div class="track">
          <div class="fill" style={`width:${Math.max(8, (Number(row.value) / maxValue) * 100)}%`}></div>
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="empty">暂无数据</div>
{/if}

<style>
  .bars {
    display: flex;
    height: 100%;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
  }

  .bar-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-2);
    font-size: 12px;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .value {
    color: var(--text-1);
    font-weight: 600;
  }

  .track {
    height: 10px;
    border-radius: 999px;
    background: rgba(22, 100, 255, .08);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #1664ff 0%, #5b8cff 100%);
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
