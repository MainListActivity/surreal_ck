<script lang="ts">
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "rows" in cache.result && cache.result.rows[0] && "x" in cache.result.rows[0] ? cache.result : null);
  const width = 520;
  const height = 180;
  const padding = 24;
  const points = $derived.by(() => {
    if (!result || result.rows.length === 0) return "";
    const max = Math.max(...result.rows.map((row) => Number(row.y) || 0), 1);
    return result.rows
      .map((row, index) => {
        const x = padding + (index / Math.max(result.rows.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - ((Number(row.y) || 0) / max) * (height - padding * 2);
        return `${x},${y}`;
      })
      .join(" ");
  });
</script>

{#if result && result.rows.length > 0}
  <div class="series">
    <svg viewBox={`0 0 ${width} ${height}`} aria-label={view.title}>
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(78,89,105,.24)" />
      <polyline fill="none" stroke="#1664ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points={points}></polyline>
      {#each result.rows as row, index}
        {@const x = padding + (index / Math.max(result.rows.length - 1, 1)) * (width - padding * 2)}
        <circle cx={x} cy={Number(points.split(" ")[index]?.split(",")[1] ?? height - padding)} r="4" fill="#1664ff"></circle>
      {/each}
    </svg>
    <div class="labels">
      {#each result.rows as row}
        <span>{row.x}</span>
      {/each}
    </div>
  </div>
{:else}
  <div class="empty">暂无数据</div>
{/if}

<style>
  .series {
    display: flex;
    height: 100%;
    flex-direction: column;
    gap: 10px;
  }

  svg {
    width: 100%;
    min-height: 160px;
    flex: 1;
  }

  .labels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));
    gap: 8px;
    color: var(--text-3);
    font-size: 11px;
  }

  .labels span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
