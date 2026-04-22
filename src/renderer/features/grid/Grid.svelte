<script lang="ts">
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import type { RowData } from "../../../shared/rpc.types";

  let { rows }: { rows: RowData[] } = $props();

  const columns: ColumnRegular[] = [
    { prop: "id", name: "ID", size: 80, readonly: true },
    { prop: "name", name: "名称", size: 200 },
    { prop: "value", name: "值", size: 200 },
  ];

  function handleBeforePasteApply(e: CustomEvent<{ parsed: string[][]; raw: string }>) {
    console.log("[grid] paste parsed:", e.detail.parsed);
  }
</script>

<RevoGrid
  source={rows}
  {columns}
  theme="compact"
  style="height: 100%; width: 100%;"
  on:beforepasteapply={handleBeforePasteApply}
/>
