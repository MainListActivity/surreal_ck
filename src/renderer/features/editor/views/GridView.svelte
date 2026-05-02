<script lang="ts">
  import { mount, onDestroy, onMount, unmount } from "svelte";
  import type { ColumnRegular, RevoGridCustomEvent } from "@revolist/svelte-datagrid";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { CellTemplateProp, RowHeaders } from "@revolist/revogrid";
  import Icon from "../../../components/Icon.svelte";
  import DatePicker from "../../../components/DatePicker.svelte";
  import { appState } from "../../../lib/app-state.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import type { GridColumnDef, RecordIdString } from "../../../../shared/rpc.types";
  import { formatDateValue } from "../../../../shared/date-format";

  /** RevoGrid 日期单元格编辑器：在单元格内挂载 DatePicker 组件并自动展开。 */
  function createDateEditor(column: GridColumnDef) {
    return class DateEditor {
      host: HTMLDivElement | null = null;
      app: ReturnType<typeof mount> | null = null;
      currentValue: Date | null = null;
      save: (value: unknown, preventFocus?: boolean) => void;
      close: (focusNext?: boolean) => void;

      constructor(
        _col: unknown,
        save: (value: unknown, preventFocus?: boolean) => void,
        close: (focusNext?: boolean) => void,
      ) {
        this.save = save;
        this.close = close;
      }

      componentDidRender() {
        if (!this.host || this.app) return;
        this.app = mount(DatePicker, {
          target: this.host,
          props: {
            value: this.currentValue,
            dateFormat: column.dateFormat,
            minDate: column.constraints?.minDate,
            maxDate: column.constraints?.maxDate,
            openOnMount: true,
            ariaLabel: column.label,
            onChange: (next: Date | null) => {
              this.currentValue = next;
              this.save(next, true);
            },
            onClose: () => {
              this.close(true);
            },
          },
        });
      }

      beforeDisconnect() {
        if (this.app) {
          unmount(this.app);
          this.app = null;
        }
      }

      render(h: (tag: string, props?: Record<string, unknown>) => unknown, extra: { model?: Record<string, unknown> } = {}) {
        const initial = extra?.model?.[column.key];
        this.currentValue = initial instanceof Date
          ? initial
          : typeof initial === "string" || typeof initial === "number"
            ? new Date(initial)
            : null;
        if (this.currentValue && Number.isNaN(this.currentValue.getTime())) this.currentValue = null;
        return h("div", {
          class: "grid-date-editor-host",
          ref: (el: HTMLDivElement | null) => { this.host = el; },
        });
      }
    };
  }

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

  type GridSourceRow = Record<string, unknown> & {
    _id: string;
    _isGroup?: boolean;
    _rowNumber?: number | null;
  };

  function isGridRecordRow(row: GridSourceRow | undefined): boolean {
    return !!row && !row._isGroup;
  }

  const rowHeaderColumn = $derived<RowHeaders>({
    size: 56,
    readonly: true,
    sortable: false,
    resizable: false,
    columnTemplate: () => "",
    cellTemplate: (h, props: CellTemplateProp) => {
      const row = props.model as GridSourceRow;
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

      return out;
    })(),
  );

  const GRID_COLUMN_WIDTH = 160;
  const GRID_ROW_HEADER_WIDTH = 56;
  const GRID_HEADER_HEIGHT = 45;
  const GRID_ROW_HEIGHT = 36;
  const ADD_FIELD_WIDTH = 56;
  const ADD_ROW_HEIGHT = 52;

  let columnWidths = $state<Record<string, number>>({});

  const addFieldColumn = $derived<ColumnRegular>({
    prop: "__add_field__",
    name: "",
    size: ADD_FIELD_WIDTH,
    minSize: ADD_FIELD_WIDTH,
    maxSize: ADD_FIELD_WIDTH,
    pin: "colPinEnd",
    readonly: true,
    sortable: false,
    filter: false,
    cellTemplate: () => "",
    columnTemplate: (h) =>
      h(
        "button",
        {
          class: {
            "grid-add-field-header": true,
          },
          type: "button",
          title: "添加一列",
          disabled: appState.readOnly || !editorStore.activeSheetId || editorStore.saving,
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            void appendField();
          },
        },
        h("span", { class: { "grid-add-field-header__icon": true }, "aria-hidden": "true" }, "+"),
      ),
  });

  const gridColumns = $derived<ColumnRegular[]>(
    [
      ...editorStore.visibleColumns.map((col) => {
        const base: ColumnRegular = {
          prop: col.key,
          name: col.label,
          size: columnWidths[col.key] ?? GRID_COLUMN_WIDTH,
        };
        if (col.fieldType === "date") {
          base.cellTemplate = (h, props: CellTemplateProp) => formatDateValue(props.model?.[col.key], col.dateFormat);
          base.editor = createDateEditor(col) as unknown as ColumnRegular["editor"];
        }
        return base;
      }),
      addFieldColumn,
    ] satisfies ColumnRegular[],
  );

  const visibleGridRows = $derived(Math.max(gridSource.length, 8));
  const gridViewportWidth = $derived(
    GRID_ROW_HEADER_WIDTH +
      editorStore.visibleColumns.reduce((sum, col) => sum + (columnWidths[col.key] ?? GRID_COLUMN_WIDTH), 0) +
      ADD_FIELD_WIDTH +
      1,
  );
  const gridViewportHeight = $derived(GRID_HEADER_HEIGHT + visibleGridRows * GRID_ROW_HEIGHT + 1);
  const tableStyle = $derived(`--grid-width:${gridViewportWidth}px; --grid-height:${gridViewportHeight}px; --add-row-height:${ADD_ROW_HEIGHT}px;`);

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

    const onCellMouseDown = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      if (mouseEvent.button !== 0) return; // 仅左键单击
      const path = typeof mouseEvent.composedPath === "function" ? mouseEvent.composedPath() : [];
      const dataCell = path.find((node) => node instanceof HTMLElement && node.classList.contains("rgCell"));
      if (!(dataCell instanceof HTMLElement)) return;
      const rawRow = dataCell.getAttribute("data-rgRow");
      const rowIndex = rawRow ? Number(rawRow) : Number.NaN;
      if (!Number.isInteger(rowIndex)) return;
      const sourceRow = gridSource[rowIndex];
      if (!isGridRecordRow(sourceRow)) return;
      const rowId = typeof sourceRow._id === "string" ? sourceRow._id : null;
      if (!rowId) return;
      editorUi.selectRow(rowId as RecordIdString);
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
        const rowId = typeof sourceRow._id === "string" ? sourceRow._id : null;
        if (!rowId) return;
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
        openRowMenu(rowId, mouseEvent.clientX, mouseEvent.clientY);
      }
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    grid.addEventListener("contextmenu", onContextMenu, true);
    grid.addEventListener("mousedown", onCellMouseDown, true);
    document.addEventListener("mousedown", onRowMenuBackdrop, true);

    cleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
      grid.removeEventListener("contextmenu", onContextMenu, true);
      grid.removeEventListener("mousedown", onCellMouseDown, true);
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
    if (isGridRecordRow(sourceRow)) {
      editorUi.selectRow(sourceRow._id as RecordIdString);
    }
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
    if (appState.readOnly || !editorStore.activeSheetId) return;
    editorStore.insertBlankRows(null, 1, "end");
  }

  async function appendField() {
    if (appState.readOnly || !editorStore.activeSheetId) return;
    await editorStore.addField();
  }

  function handleAfterColumnResize(event: RevoGridCustomEvent<{ [index: number]: ColumnRegular }>) {
    const resizedColumns = Object.values(event.detail ?? {});
    if (!resizedColumns.length) return;

    const next = { ...columnWidths };
    let changed = false;

    for (const column of resizedColumns) {
      if (typeof column.prop !== "string" || column.prop === addFieldColumn.prop) continue;
      if (typeof column.size !== "number") continue;
      if (next[column.prop] === column.size) continue;
      next[column.prop] = column.size;
      changed = true;
    }

    if (changed) {
      columnWidths = next;
    }
  }
</script>

<div class="grid-wrap">
  <section class="grid-shell" aria-label="表格视图">
    <div class="grid-table" style={tableStyle}>
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
          disableVirtualX={true}
          disableVirtualY={true}
          hideAttribution={true}
          applyOnClose={true}
          readonly={appState.readOnly}
          style="height: 100%; width: 100%;"
          on:afterfocus={handleFocus}
          on:afteredit={handleAfterEdit}
          on:aftercolumnresize={handleAfterColumnResize}
        />
      </div>
      <button
        type="button"
        class="grid-footer"
        aria-label="添加一行"
        title="添加一行"
        onclick={appendRowAtEnd}
        disabled={appState.readOnly || !editorStore.activeSheetId}
      >
        <span class="footer-add-icon">+</span>
      </button>
    </div>
  </section>
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
    align-items: stretch;
    justify-content: flex-start;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    overflow: auto;
    padding: 18px 22px;
    background: #f4f6f9;
  }

  .grid-shell {
    display: block;
    min-width: 0;
    width: max-content;
    min-height: max-content;
  }

  .grid-table {
    display: grid;
    width: var(--grid-width);
    min-width: var(--grid-width);
    grid-template-columns: var(--grid-width);
    grid-template-rows: var(--grid-height) var(--add-row-height);
    align-items: start;
  }

  .grid-card {
    display: flex;
    width: var(--grid-width);
    height: var(--grid-height);
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px 8px 0 0;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  }

  .grid-footer {
    display: flex;
    width: var(--grid-width);
    height: var(--add-row-height);
    align-items: center;
    justify-content: flex-start;
    padding: 0 0 0 28px;
    border: 1px solid var(--border);
    border-top: 0;
    border-radius: 0 0 8px 8px;
    background: #fff;
    color: var(--text-3);
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .03);
    transition: background .16s ease, color .16s ease, box-shadow .16s ease;
  }

  .grid-footer:hover:not(:disabled) {
    background: #eef5ff;
    color: var(--primary);
    box-shadow: inset 0 0 0 1px rgba(37, 99, 235, .08);
  }

  .grid-footer:disabled {
    opacity: .5;
    cursor: not-allowed;
  }

  .footer-add-icon {
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    border: 1px solid #c9d1de;
    border-radius: 999px;
    background: #fff;
    color: currentColor;
    font-size: 16px;
    line-height: 1;
  }

  :global(.grid-card revo-grid) {
    min-height: 0;
    overflow: hidden;
  }

  :global(.grid-card revo-grid revogr-scroll-virtual.vertical),
  :global(.grid-card revo-grid revogr-scroll-virtual.horizontal) {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    min-width: 0 !important;
    min-height: 0 !important;
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

  :global(revo-grid .grid-date-editor-host) {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--surface);
    box-shadow: inset 0 0 0 2px var(--primary);
  }

  :global(revo-grid .grid-add-field-header) {
    display: inline-flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: #7b8494;
    cursor: pointer;
    transition: background .16s ease, color .16s ease;
  }

  :global(revo-grid .grid-add-field-header:hover:not(:disabled)) {
    background: #eef5ff;
    color: var(--primary);
  }

  :global(revo-grid .grid-add-field-header:disabled) {
    opacity: .5;
    cursor: not-allowed;
  }

  :global(revo-grid .grid-add-field-header__icon) {
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    line-height: 1;
    font-weight: 300;
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
