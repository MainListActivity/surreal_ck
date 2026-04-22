<script lang="ts">
  import Grid from "./features/grid/Grid.svelte";
  import { rpc, onPushRows } from "./lib/rpc";
  import type { RowData } from "../shared/rpc.types";

  let rows: RowData[] = $state([]);

  onPushRows((newRows) => {
    rows = newRows;
  });

  async function runQuery() {
    const result = await rpc.request("query", { sql: "RETURN 1" });
    console.log("[app] query result:", result);
  }
</script>

<div class="app">
  <header>
    <h1>SurrealCK</h1>
    <button onclick={runQuery}>测试查询</button>
  </header>
  <main>
    <Grid {rows} />
  </main>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: sans-serif;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #e0e0e0;
    background: #174b47;
    color: white;
  }

  header h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }

  header button {
    padding: 0.3rem 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: 4px;
    background: transparent;
    color: white;
    cursor: pointer;
    font-size: 0.85rem;
  }

  main {
    flex: 1;
    overflow: hidden;
  }
</style>
