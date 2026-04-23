<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import type { CreditorRow } from "../../lib/types";

  let {
    rows,
    onRowsChange,
    onFocusRow,
    onClipboardStatus,
  }: {
    rows: CreditorRow[];
    onRowsChange?: (rows: CreditorRow[]) => void;
    onFocusRow?: (row: CreditorRow | null) => void;
    onClipboardStatus?: (message: string) => void;
  } = $props();

  let gridRef: {
    getWebComponent: () => HTMLElement & {
      getFocused?: () => Promise<{ y?: number } | undefined>;
      getSource?: () => Promise<CreditorRow[]>;
    };
  } | null = null;

  const typeColor: Record<string, { bg: string; color: string }> = {
    普通债权: { bg: "#EBF0FF", color: "#1664FF" },
    有担保债权: { bg: "#F0EDFF", color: "#7B61FF" },
    职工债权: { bg: "#E8FFEA", color: "#00875A" },
    工程款债权: { bg: "#FFF7E8", color: "#FF7D00" },
    税务债权: { bg: "#FFECE8", color: "#F53F3F" },
  };

  const statusColor: Record<string, { bg: string; color: string }> = {
    待审核: { bg: "#FFF7E8", color: "#FF7D00" },
    审核中: { bg: "#EBF0FF", color: "#1664FF" },
    已通过: { bg: "#E8FFEA", color: "#00B42A" },
    已退回: { bg: "#FFECE8", color: "#F53F3F" },
  };

  function pillTemplate(kind: "type" | "status") {
    return (h: (tag: string, props: Record<string, unknown>, children?: unknown) => unknown, { value }: { value: string }) => {
      const cfg = kind === "type" ? typeColor[value] : statusColor[value];
      return h(
        "span",
        {
          class: `rg-pill ${kind === "status" ? "with-dot" : ""}`,
          style: { "--pill-bg": cfg?.bg ?? "#F2F3F5", "--pill-color": cfg?.color ?? "#86909C" },
        },
        value,
      );
    };
  }

  const columns: ColumnRegular[] = [
    { prop: "name", name: "债权人名称", size: 220 },
    { prop: "idNo", name: "证件号码", size: 178 },
    { prop: "contact", name: "联系方式", size: 132 },
    {
      prop: "amount",
      name: "申报金额（元）",
      size: 150,
      cellTemplate(h, { value }) {
        return h("span", { class: "rg-money" }, `¥ ${value}`);
      },
    },
    { prop: "type", name: "债权类型", size: 124, cellTemplate: pillTemplate("type") },
    { prop: "date", name: "申报日期", size: 116 },
    {
      prop: "docs",
      name: "凭证附件",
      size: 96,
      cellTemplate(h, { value }) {
        return h("span", { class: "rg-attach" }, `${value} 份`);
      },
    },
    { prop: "status", name: "审核状态", size: 116, cellTemplate: pillTemplate("status") },
    { prop: "note", name: "备注", size: 240 },
  ];

  const summarySource = $derived([
    {
      name: `共 ${rows.length} 条`,
      amount: rows.reduce((sum, row) => sum + Number(row.amount.replace(/,/g, "")), 0).toLocaleString("zh-CN", { minimumFractionDigits: 2 }),
      docs: rows.reduce((sum, row) => sum + row.docs, 0),
      status: `通过 ${rows.filter((row) => row.status === "已通过").length}/${rows.length}`,
    },
  ]);

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
  pinnedBottomSource={summarySource}
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

  :global(.rg-money) {
    color: #0070c0;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }

  :global(.rg-pill),
  :global(.rg-attach) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 20px;
    background: var(--pill-bg, #f2f3f5);
    color: var(--pill-color, #86909c);
    font-size: 11px;
    font-weight: 600;
  }

  :global(.rg-pill.with-dot::before) {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    content: "";
  }

  :global(.rg-attach) {
    border-radius: 6px;
    background: #fff7e8;
    color: #ff7d00;
  }
</style>
