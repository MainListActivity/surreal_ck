<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import type { GridRow } from "@surreal-ck/shared/rpc.types";

  /**
   * 通用 RevoGrid 封装：吃动态 {@link GridRow} 行 + {@link ColumnRegular} 列定义，
   * 把 RevoGrid 的剪贴板 / 编辑 / 聚焦事件收敛成回调。
   *
   * 不含任何业务（债权 mock）列；列由调用方按 sheet 的 column_defs 生成。GridView
   * 因为有 date / reference 等定制 cellTemplate / editor，直接内联 RevoGrid 而不走本
   * 组件——本组件供「不需要定制单元格」的简单表格视图复用。
   */
  type GridSourceRow = Record<string, unknown> & { _id?: string };

  let {
    rows,
    columns,
    rowSize = 36,
    onRowsChange,
    onFocusRow,
    onClipboardStatus,
  }: {
    rows: GridSourceRow[];
    columns: ColumnRegular[];
    rowSize?: number;
    onRowsChange?: (rows: GridSourceRow[]) => void;
    onFocusRow?: (row: GridSourceRow | null) => void;
    onClipboardStatus?: (message: string) => void;
  } = $props();

  let gridRef: {
    getWebComponent: () => HTMLElement & {
      getFocused?: () => Promise<{ y?: number } | undefined>;
      getSource?: () => Promise<GridSourceRow[]>;
    };
  } | null = null;

  let cleanup: (() => void) | undefined;

  onMount(() => {
    const grid = gridRef?.getWebComponent();
    if (!grid) return;

    const beforePaste = (event: Event) => {
      const detail = (event as CustomEvent<{ parsed?: unknown[][] }>).detail;
      const parsed = detail?.parsed;
      if (parsed?.length) {
        onClipboardStatus?.(`检测到 Excel/TSV 粘贴：${parsed.length} 行 × ${parsed[0]?.length ?? 0} 列`);
      }
    };

    const afterPaste = async () => {
      onClipboardStatus?.("粘贴已应用到表格");
      const next = await grid.getSource?.();
      if (next?.length) onRowsChange?.([...next]);
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    cleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
    };
  });

  onDestroy(() => cleanup?.());

  async function handleFocus() {
    const grid = gridRef?.getWebComponent();
    const focused = await grid?.getFocused?.();
    const rowIndex = focused?.y;
    onFocusRow?.(typeof rowIndex === "number" ? rows[rowIndex] ?? null : null);
  }

  async function handleAfterEdit() {
    const next = await gridRef?.getWebComponent()?.getSource?.();
    if (next?.length) onRowsChange?.([...next]);
  }
</script>

<RevoGrid
  bind:this={gridRef}
  source={rows}
  {columns}
  theme="compact"
  rowHeaders={true}
  range={true}
  resize={true}
  useClipboard={true}
  canFocus={true}
  {rowSize}
  frameSize={35}
  stretch="none"
  hideAttribution={true}
  style="height: 100%; width: 100%;"
  on:afterfocus={handleFocus}
  on:afteredit={handleAfterEdit}
/>

<style>
  :global(revo-grid) {
    --revo-grid-font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    --revo-grid-primary: var(--primary);
    --revo-grid-cell-border: var(--border);
    --revo-grid-header-border: var(--border);
    --revo-grid-row-hover: #f7f9ff;
    --revo-grid-focused-bg: #edf2ff;
    --revo-grid-header-bg: #f7f8fa;
    --revo-grid-text: var(--text-2);
    border: 0;
  }

  :global(revo-grid .rgCell),
  :global(revo-grid .rgHeaderCell) {
    font-size: 12px;
  }
</style>
