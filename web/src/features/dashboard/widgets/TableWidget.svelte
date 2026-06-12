<script lang="ts">
  import type { DashboardNormalizedResult } from "@surreal-ck/shared/rpc.types";
  import { toTableWidgetModel } from "./model";

  let { result }: { title: string; result?: DashboardNormalizedResult; displaySpec?: Record<string, unknown> } = $props();

  const model = $derived(toTableWidgetModel(result));
</script>

{#if model.columns.length > 0}
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          {#each model.columns as column}
            <th>{column.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each model.rows as row}
          <tr>
            {#each row.cells as cell}
              <td>{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="empty">{model.emptyText}</div>
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
