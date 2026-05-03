<script lang="ts">
  import type { DashboardCacheDTO, DashboardViewDTO } from "../../../../shared/rpc.types";

  let { view, cache }: { view: DashboardViewDTO; cache?: DashboardCacheDTO } = $props();
  const result = $derived(cache?.result && "columns" in cache.result ? cache.result : null);
</script>

{#if result}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          {#each result.columns as column}
            <th>{column.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each result.rows as row}
          <tr>
            {#each result.columns as column}
              <td>{row[column.key] ?? ""}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">暂无数据</div>
{/if}

<style>
  .table-wrap {
    height: 100%;
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    background: rgba(247, 248, 250, .96);
    color: var(--text-2);
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
</style>
