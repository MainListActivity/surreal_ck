<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  const groupKey = $derived(editorStore.viewParams.groupBy ?? null);

  /** 分组开启时按分组键插入分组分隔行，方便用户在表格内直接看见分组归属。 */
  const gridSource = $derived(
    (() => {
      const rows = editorStore.rows.map((row) => ({ _id: row.id, ...row.values }));
      if (!groupKey) return rows;

      const sorted = rows.slice().sort((a, b) => {
        const av = String(a[groupKey] ?? "");
        const bv = String(b[groupKey] ?? "");
        return av.localeCompare(bv);
      });

      const out: Array<Record<string, unknown>> = [];
      let lastGroup: string | undefined;
      for (const row of sorted) {
        const g = String(row[groupKey] ?? "未分组");
        if (g !== lastGroup) {
          out.push({ _id: `__group:${g}`, _isGroup: true, [groupKey]: `▸ ${g}` });
          lastGroup = g;
        }
        out.push(row);
      }
      return out;
    })(),
  );

  const gridColumns = $derived<ColumnRegular[]>(
    editorStore.visibleColumns.map((col) => ({
      prop: col.key,
      name: col.label,
      size: 160,
    })),
  );

  let gridRef = $state<{
    getWebComponent: () => HTMLElement & {
      getFocused?: () => Promise<{ y?: number } | undefined>;
      getSource?: () => Promise<Array<Record<string, unknown>>>;
    };
  } | null>(null);

  let cleanup: (() => void) | undefined;

  onMount(() => {
    const grid = gridRef?.getWebComponent();
    if (!grid) return;

    const beforePaste = (event: Event) => {
      const detail = (event as CustomEvent<{ parsed?: unknown[][] }>).detail;
      const parsed = detail?.parsed;
      if (parsed?.length) {
        editorUi.clipboardStatus = `检测到粘贴：${parsed.length} 行 × ${parsed[0]?.length ?? 0} 列`;
      }
    };

    const afterPaste = async () => {
      if (appState.readOnly) {
        editorUi.clipboardStatus = "离线模式，粘贴未保存";
        return;
      }
      editorUi.clipboardStatus = "粘贴已应用,保存中…";
      const next = await grid.getSource?.();
      if (next?.length) {
        await editorStore.saveFromSource(next.filter((r) => !r._isGroup));
        editorUi.clipboardStatus = editorStore.saveError
          ? `保存失败: ${editorStore.saveError}`
          : "已保存";
      }
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    cleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
    };
  });

  onDestroy(() => cleanup?.());

  async function handleAfterEdit() {
    if (appState.readOnly) return;
    const next = await gridRef?.getWebComponent()?.getSource?.();
    if (next?.length) {
      await editorStore.saveFromSource(next.filter((r) => !r._isGroup));
    }
  }

  async function handleFocus() {
    const grid = gridRef?.getWebComponent();
    const focused = await grid?.getFocused?.();
    const rowIndex = focused?.y;
    editorUi.selectRow(
      typeof rowIndex === "number" ? (editorStore.rows[rowIndex]?.id ?? null) : null,
    );
  }
</script>

<div class="grid-wrap">
  <RevoGrid
    bind:this={gridRef}
    source={gridSource}
    columns={gridColumns}
    theme="compact"
    rowHeaders={true}
    range={true}
    resize={true}
    useClipboard={true}
    canFocus={true}
    rowSize={36}
    frameSize={35}
    stretch="none"
    hideAttribution={true}
    readonly={appState.readOnly}
    style="height: 100%; width: 100%;"
    on:afterfocus={handleFocus}
    on:afteredit={handleAfterEdit}
  />
</div>

<style>
  .grid-wrap {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    background: #fafbfc;
  }

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
