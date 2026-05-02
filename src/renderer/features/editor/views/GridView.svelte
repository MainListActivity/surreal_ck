<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ColumnRegular } from "@revolist/svelte-datagrid";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { BeforeSaveDataDetails, CellTemplateProp, ColumnTemplateProp, RowHeaders } from "@revolist/revogrid";
  import Icon from "../../../components/Icon.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import type { RecordIdString } from "../../../../shared/rpc.types";

  type RowMenuState = {
    open: boolean;
    rowId: RecordIdString | null;
    x: number;
    y: number;
    insertAboveCount: number;
    insertBelowCount: number;
  };

  let rowMenu = $state<RowMenuState>({
    open: false,
    rowId: null,
    x: 0,
    y: 0,
    insertAboveCount: 1,
    insertBelowCount: 1,
  });

  const groupKey = $derived(editorStore.viewParams.groupBy ?? null);

  const ADD_FIELD_PROP = "__grid_add_field__";
  const ADD_ROW_ID = "__grid_add_row__";

  type GridSourceRow = Record<string, unknown> & {
    _id: string;
    _isGroup?: boolean;
    _isAddRow?: boolean;
    _rowNumber?: number | null;
  };

  function isAddFieldProp(prop: unknown): boolean {
    return prop === ADD_FIELD_PROP;
  }

  function isGridRecordRow(row: GridSourceRow | undefined): boolean {
    return !!row && !row._isGroup && !row._isAddRow;
  }

  function isAddRow(row: GridSourceRow | undefined): boolean {
    return !!row?._isAddRow;
  }

  function createPlusPill(
    h: (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown,
    label: string,
  ) {
    return h(
      "div",
      {
        "data-grid-action": label,
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "20px",
          height: "20px",
          border: "1px solid #cfd6e4",
          borderRadius: "999px",
          color: "#5b6477",
          fontSize: "14px",
          fontWeight: "600",
          lineHeight: "1",
          background: "#ffffff",
          boxSizing: "border-box",
          pointerEvents: "none",
        },
      },
      "+",
    );
  }

  const rowHeaderColumn = $derived<RowHeaders>({
    size: 56,
    readonly: true,
    sortable: false,
    resizable: false,
    columnTemplate: () => "",
    cellTemplate: (h, props: CellTemplateProp) => {
      const row = props.model as GridSourceRow;
      if (isAddRow(row)) {
        return createPlusPill(h, "append-row");
      }
      if (row?._isGroup) return "";
      return String(row?._rowNumber ?? props.rowIndex + 1);
    },
  });

  /** 分组开启时按分组键插入分组分隔行，方便用户在表格内直接看见分组归属。 */
  const gridSource = $derived<GridSourceRow[]>(
    (() => {
      const rows = editorStore.rows.map((row) => ({ _id: row.id, ...row.values })) as GridSourceRow[];
      const out: GridSourceRow[] = [];
      let rowNumber = 0;

      if (!groupKey) {
        for (const row of rows) {
          rowNumber += 1;
          out.push({ ...row, _rowNumber: rowNumber });
        }
      } else {
        const sorted = rows.slice().sort((a, b) => {
          const av = String(a[groupKey] ?? "");
          const bv = String(b[groupKey] ?? "");
          return av.localeCompare(bv);
        });

        let lastGroup: string | undefined;
        for (const row of sorted) {
          const g = String(row[groupKey] ?? "未分组");
          if (g !== lastGroup) {
            out.push({ _id: `__group:${g}`, _isGroup: true, _rowNumber: null, [groupKey]: `▸ ${g}` });
            lastGroup = g;
          }
          rowNumber += 1;
          out.push({ ...row, _rowNumber: rowNumber });
        }
      }

      if (editorStore.activeSheetId) {
        out.push({ _id: ADD_ROW_ID, _isAddRow: true, _rowNumber: null });
      }
      return out;
    })(),
  );

  const gridColumns = $derived<ColumnRegular[]>(
    [
      ...editorStore.visibleColumns.map((col) => ({
        prop: col.key,
        name: col.label,
        size: 160,
        readonly: ({ model }: BeforeSaveDataDetails) => !!(model as GridSourceRow)?._isAddRow,
      })),
      ...(editorStore.activeSheetId
        ? [{
            prop: ADD_FIELD_PROP,
            name: "",
            size: 42,
            minSize: 42,
            maxSize: 42,
            readonly: true,
            sortable: false,
            resize: false,
            columnProperties: () => ({
              style: {
                padding: "0",
                justifyContent: "center",
                cursor: appState.readOnly ? "not-allowed" : "pointer",
              },
            }),
            columnTemplate: (
              h: (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown,
              _props: ColumnTemplateProp,
            ) => createPlusPill(h, "append-field"),
            cellProperties: ({ model }: BeforeSaveDataDetails) => ({
              style: {
                cursor:
                  appState.readOnly || (model as GridSourceRow)?._isAddRow ? "default" : "pointer",
              },
            }),
            cellTemplate: () => "",
          }]
        : []),
    ],
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
        const ok = await editorStore.saveFromSource(next.filter((r) => !r._isGroup));
        editorUi.clipboardStatus = ok ? "已保存" : `保存失败: ${editorStore.saveError}`;
      }
    };

    const onContextMenu = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const path = typeof mouseEvent.composedPath === "function" ? mouseEvent.composedPath() : [];

      const headerCell = path.find((node) => node instanceof HTMLElement && node.classList.contains("rgHeaderCell"));
      if (headerCell instanceof HTMLElement) {
        const isResizeHandle = path.some((node) => node instanceof HTMLElement && node.classList.contains("resizable"));
        if (isResizeHandle) return;
        const rawIndex = headerCell.getAttribute("data-rgCol");
        const index = rawIndex ? Number(rawIndex) : Number.NaN;
        if (!Number.isInteger(index)) return;
        if (index === gridColumns.length - 1) return;
        const column = editorStore.visibleColumns[index];
        if (!column) return;
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        editorUi.openFieldMenu(column.key, mouseEvent.clientX, mouseEvent.clientY);
        return;
      }

      const dataCell = path.find((node) => node instanceof HTMLElement && node.classList.contains("rgCell"));
      if (dataCell instanceof HTMLElement) {
        const rawRow = dataCell.getAttribute("data-rgRow");
        const rowIndex = rawRow ? Number(rawRow) : Number.NaN;
        if (!Number.isInteger(rowIndex)) return;
        const sourceRow = gridSource[rowIndex];
        if (!isGridRecordRow(sourceRow)) return;
        const rawCol = dataCell.getAttribute("data-rgCol");
        const colIndex = rawCol ? Number(rawCol) : Number.NaN;
        if (Number.isInteger(colIndex) && isAddFieldProp(gridColumns[colIndex]?.prop)) return;
        const rowId = typeof sourceRow._id === "string" ? sourceRow._id : null;
        if (!rowId) return;
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        openRowMenu(rowId, mouseEvent.clientX, mouseEvent.clientY);
      }
    };

    const onGridClick = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const path = typeof mouseEvent.composedPath === "function" ? mouseEvent.composedPath() : [];
      const headerCell = path.find((node) => node instanceof HTMLElement && node.classList.contains("rgHeaderCell"));
      if (headerCell instanceof HTMLElement) {
        const rawIndex = headerCell.getAttribute("data-rgCol");
        const index = rawIndex ? Number(rawIndex) : Number.NaN;
        if (Number.isInteger(index) && isAddFieldProp(gridColumns[index]?.prop)) {
          mouseEvent.preventDefault();
          mouseEvent.stopPropagation();
          void appendField();
          return;
        }
      }

      const cell = path.find((node) => node instanceof HTMLElement && node.classList.contains("rgCell"));
      if (!(cell instanceof HTMLElement)) return;

      const rawRow = cell.getAttribute("data-rgRow");
      const rowIndex = rawRow ? Number(rawRow) : Number.NaN;
      const row = Number.isInteger(rowIndex) ? gridSource[rowIndex] : undefined;
      if (isAddRow(row)) {
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        appendRowAtEnd();
        return;
      }

      const rawCol = cell.getAttribute("data-rgCol");
      const colIndex = rawCol ? Number(rawCol) : Number.NaN;
      if (Number.isInteger(colIndex) && isAddFieldProp(gridColumns[colIndex]?.prop)) {
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        void appendField();
      }
    };

    const beforeEditStart = (event: Event) => {
      const detail = (event as CustomEvent<BeforeSaveDataDetails>).detail;
      const row = gridSource[detail.rowIndex];
      if (isAddRow(row) || isAddFieldProp(detail.prop)) {
        event.preventDefault();
      }
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    grid.addEventListener("beforeeditstart", beforeEditStart);
    grid.addEventListener("click", onGridClick, true);
    grid.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("mousedown", onRowMenuBackdrop, true);

    cleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
      grid.removeEventListener("beforeeditstart", beforeEditStart);
      grid.removeEventListener("click", onGridClick, true);
      grid.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("mousedown", onRowMenuBackdrop, true);
    };
  });

  onDestroy(() => cleanup?.());

  async function handleAfterEdit() {
    if (appState.readOnly) return;
    const next = await gridRef?.getWebComponent()?.getSource?.();
    if (next?.length) {
      const ok = await editorStore.saveFromSource(next.filter((r) => !r._isGroup));
      if (!ok && editorStore.saveError) {
        editorUi.clipboardStatus = `保存失败: ${editorStore.saveError}`;
      }
    }
  }

  async function handleFocus() {
    const grid = gridRef?.getWebComponent();
    const focused = await grid?.getFocused?.();
    const rowIndex = focused?.y;
    const sourceRow = typeof rowIndex === "number" ? gridSource[rowIndex] : undefined;
    editorUi.selectRow(isGridRecordRow(sourceRow) ? (sourceRow._id as RecordIdString) : null);
  }

  function openFieldEditor() {
    if (!editorUi.fieldMenu.fieldKey) return;
    editorUi.openFieldEditor(editorUi.fieldMenu.fieldKey);
  }

  function hideField() {
    const fieldKey = editorUi.fieldMenu.fieldKey;
    if (!fieldKey) return;
    const hidden = new Set(editorStore.viewParams.hiddenFields ?? []);
    hidden.add(fieldKey);
    editorStore.setHiddenFields(Array.from(hidden));
    editorUi.closeFieldMenu();
  }

  function openRowMenu(rowId: RecordIdString, x: number, y: number) {
    editorUi.selectRow(rowId);
    rowMenu = {
      open: true,
      rowId,
      x,
      y,
      insertAboveCount: 1,
      insertBelowCount: 1,
    };
  }

  function closeRowMenu() {
    rowMenu = { ...rowMenu, open: false, rowId: null };
  }

  function onRowMenuBackdrop(event: MouseEvent) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(".row-menu")) return;
    if (rowMenu.open) closeRowMenu();
  }

  function expandRecord() {
    if (!rowMenu.rowId) return;
    editorUi.selectRow(rowMenu.rowId);
    editorUi.openPanel("detail");
    closeRowMenu();
  }

  function duplicateRecord() {
    if (appState.readOnly || !rowMenu.rowId) return;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    editorStore.duplicateRowAsDraft(targetId);
  }

  function insertRows(direction: "above" | "below") {
    if (appState.readOnly || !rowMenu.rowId) return;
    const count = direction === "above" ? rowMenu.insertAboveCount : rowMenu.insertBelowCount;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    editorStore.insertBlankRows(targetId, count, direction);
  }

  async function deleteRecord() {
    if (appState.readOnly || !rowMenu.rowId) return;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    await editorStore.deleteRowIds([targetId]);
  }

  function appendRowAtEnd() {
    if (appState.readOnly) return;
    editorStore.insertBlankRows(null, 1, "end");
  }

  async function appendField() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    await editorStore.addField();
  }
</script>

<div class="grid-wrap">
  <div class="grid-card">
    <RevoGrid
      bind:this={gridRef}
      source={gridSource}
      columns={gridColumns}
      theme="compact"
      rowHeaders={rowHeaderColumn}
      range={true}
      resize={true}
      useClipboard={true}
      canFocus={true}
      rowSize={36}
      frameSize={35}
      stretch="none"
      hideAttribution={true}
      applyOnClose={true}
      readonly={appState.readOnly}
      style="height: 100%; width: 100%;"
      on:afterfocus={handleFocus}
      on:afteredit={handleAfterEdit}
    />
  </div>
</div>

{#if rowMenu.open && rowMenu.rowId}
  <div
    class="row-menu"
    role="menu"
    aria-label="行操作菜单"
    tabindex="-1"
    style={`left:${rowMenu.x}px; top:${rowMenu.y}px;`}
    onmousedown={(event) => event.stopPropagation()}
  >
    <button class="menu-item" role="menuitem" onclick={expandRecord}>
      <Icon name="externalLink" size={13} />
      <span>展开记录</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onclick={duplicateRecord} disabled={appState.readOnly}>
      <Icon name="copy" size={13} />
      <span>创建副本</span>
    </button>
    <button
      type="button"
      class="menu-row"
      role="menuitem"
      onclick={() => insertRows("above")}
      disabled={appState.readOnly}
    >
      <Icon name="arrowUp" size={13} />
      <span>在上方插入</span>
      <input
        type="number"
        min="1"
        max="200"
        bind:value={rowMenu.insertAboveCount}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        onmousedown={(e) => e.stopPropagation()}
        disabled={appState.readOnly}
      />
      <span class="muted">行</span>
    </button>
    <button
      type="button"
      class="menu-row"
      role="menuitem"
      onclick={() => insertRows("below")}
      disabled={appState.readOnly}
    >
      <Icon name="arrowDown" size={13} />
      <span>在下方插入</span>
      <input
        type="number"
        min="1"
        max="200"
        bind:value={rowMenu.insertBelowCount}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        onmousedown={(e) => e.stopPropagation()}
        disabled={appState.readOnly}
      />
      <span class="muted">行</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" disabled>
      <Icon name="link" size={13} />
      <span>获取分享链接</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item danger" role="menuitem" onclick={deleteRecord} disabled={appState.readOnly}>
      <Icon name="trash" size={13} />
      <span>删除记录</span>
    </button>
  </div>
{/if}

{#if editorUi.fieldMenu.open && editorUi.fieldMenu.fieldKey}
  <div
    class="field-menu"
    role="menu"
    aria-label="字段菜单"
    tabindex="-1"
    style={`left:${editorUi.fieldMenu.x}px; top:${editorUi.fieldMenu.y}px;`}
    onmousedown={(event) => event.stopPropagation()}
  >
    <div class="field-menu-head">
      <strong>{editorStore.columns.find((col) => col.key === editorUi.fieldMenu.fieldKey)?.label ?? "字段"}</strong>
      <span>{editorUi.fieldMenu.fieldKey}</span>
    </div>
    <button class="menu-item" role="menuitem" onclick={openFieldEditor}>
      <span>字段设置</span>
      <Icon name="settings" size={13} />
    </button>
    <button class="menu-item" role="menuitem" onclick={hideField}>
      <span>隐藏字段</span>
      <Icon name="eye" size={13} />
    </button>
  </div>
{/if}

<style>
  .grid-wrap {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    padding: 12px 16px 16px;
    background: #f4f6f9;
  }

  /* 表格主体卡片：白底圆角加细边，让数据区域从灰色背景中突出。 */
  .grid-card {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
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

  .field-menu {
    position: fixed;
    z-index: 60;
    display: grid;
    min-width: 188px;
    padding: 8px;
    border: 1px solid #dfe4ee;
    border-radius: 12px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 42px rgba(15, 23, 42, .16);
    backdrop-filter: blur(12px);
  }

  .field-menu-head {
    display: grid;
    gap: 3px;
    padding: 4px 6px 8px;
    border-bottom: 1px solid #edf1f6;
    margin-bottom: 4px;
  }

  .field-menu-head strong {
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.3;
  }

  .field-menu-head span {
    color: var(--text-3);
    font-size: 11px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
  }

  .menu-item:hover {
    background: #f5f8ff;
    color: var(--primary);
  }

  .row-menu {
    position: fixed;
    z-index: 60;
    display: grid;
    min-width: 220px;
    padding: 6px;
    border: 1px solid #dfe4ee;
    border-radius: 12px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 42px rgba(15, 23, 42, .16);
    backdrop-filter: blur(12px);
  }

  .row-menu .menu-item {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .row-menu .menu-item:hover:not(:disabled) {
    background: #f5f8ff;
    color: var(--primary);
  }

  .row-menu .menu-item:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .row-menu .menu-item.danger {
    color: var(--error, #e54848);
  }

  .row-menu .menu-item.danger:hover:not(:disabled) {
    background: #fff0f0;
    color: var(--error, #e54848);
  }

  .row-menu .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: #edf1f6;
  }

  .row-menu .menu-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .row-menu .menu-row:hover:not(:disabled) {
    background: #f5f8ff;
  }

  .row-menu .menu-row > span {
    flex-shrink: 0;
  }

  .row-menu .menu-row .muted {
    color: var(--text-3);
  }

  .row-menu .menu-row input {
    width: 56px;
    height: 22px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    text-align: center;
    margin-left: auto;
    cursor: text;
  }

  .row-menu .menu-row:disabled,
  .row-menu .menu-row input:disabled {
    opacity: .55;
    cursor: not-allowed;
  }
</style>
