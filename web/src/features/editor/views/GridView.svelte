<script lang="ts">
  import { mount, onDestroy, onMount, unmount } from "svelte";
  import type { ColumnRegular, RevoGridCustomEvent } from "@revolist/svelte-datagrid";
  import { RevoGrid } from "@revolist/svelte-datagrid";
  import type { CellTemplateProp, RowHeaders } from "@revolist/revogrid";
  import { ExternalLink, Copy, ArrowUp, ArrowDown, Link, Trash2, Settings, Eye } from "@lucide/svelte";
  import RecordPicker from "../../../components/RecordPicker.svelte";
  import ReferenceCell from "../components/ReferenceCell.svelte";
  import { editorStore } from "../../../lib/editor-store.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import { canWriteEntityData as canWriteEntityDataFn, canWriteSharedStructure as canWriteSharedStructureFn } from "../../../lib/permissions.svelte";
  import { getFieldTypeIconPaths, getFieldTypeMeta } from "../lib/field-type-meta";
  import type { GridColumnDef, RecordIdString } from "@surreal-ck/shared/rpc.types";
  import { formatDateValue } from "@surreal-ck/shared/date-format";

  // ── 范围裁定 ──────────────────────────────────────────────────
  //  - 引用单元格（07e）：ReferenceCell 徽章展示目标记录展示值 + RecordPicker 内联编辑器。
  //  - 日期单元格：只读展示（formatDateValue），内联 DatePicker 编辑器留后续簇（不在 07e 范围）。
  // 这些占位都不阻断主路：行仍可读、文本/数字/勾选单元格仍可编辑直连 UPDATE。

  /** RevoGrid 引用单元格编辑器：在单元格内挂载 RecordPicker 组件并自动展开。 */
  function createReferenceEditor(column: GridColumnDef) {
    return class ReferenceEditor {
      host: HTMLDivElement | null = null;
      app: ReturnType<typeof mount> | null = null;
      currentValue: RecordIdString | RecordIdString[] | null = null;
      editCell?: { val?: unknown };
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

      coerceValue(input: unknown): RecordIdString | RecordIdString[] | null {
        if (input == null || input === "") return null;
        if (Array.isArray(input)) {
          const ids = input.filter((v): v is string => typeof v === "string" && v.length > 0) as RecordIdString[];
          return column.referenceMultiple ? (ids.length ? ids : null) : (ids[0] ?? null);
        }
        if (typeof input === "string") return column.referenceMultiple ? [input as RecordIdString] : (input as RecordIdString);
        return null;
      }

      componentDidRender() {
        if (!this.host || this.app) return;
        if (!column.referenceTable) {
          this.close(true);
          return;
        }
        this.app = mount(RecordPicker, {
          target: this.host,
          props: {
            value: this.currentValue,
            table: column.referenceTable,
            displayKey: column.referenceDisplayKey,
            multiple: Boolean(column.referenceMultiple),
            openOnMount: true,
            fullWidth: true,
            ariaLabel: column.label,
            onChange: (next: RecordIdString | RecordIdString[] | null) => {
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
        const initial = this.editCell?.val ?? extra?.model?.[column.key];
        this.currentValue = this.coerceValue(initial);
        return h("div", {
          class: "grid-reference-editor-host",
          ref: (el: HTMLDivElement | null) => { this.host = el; },
        });
      }
    };
  }

  /** 在单元格 DOM 内挂载 ReferenceCell 组件。RevoGrid 的 cellTemplate 支持函数式 vnode + ref 回调。 */
  function mountReferenceCellInto(host: HTMLElement, ids: RecordIdString[]): () => void {
    const app = mount(ReferenceCell, { target: host, props: { ids } });
    return () => unmount(app);
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

  const tableView = $derived(editorStore.tableViewAdapter);
  const groupKey = $derived(editorStore.viewParams.groupBy ?? null);
  const canWriteEntityData = $derived(canWriteEntityDataFn());
  const canWriteSharedStructure = $derived(canWriteSharedStructureFn());

  type GridSourceRow = Record<string, unknown> & {
    _id: string;
    _isGroup?: boolean;
    _rowNumber?: number | null;
  };

  function isGridRecordRow(row: GridSourceRow | undefined): boolean {
    return !!row && !row._isGroup;
  }

  /** 在右侧详情面板展开某行记录（行首展开图标 + 行菜单「展开记录」共用）。 */
  function openRecordDetail(rowId: RecordIdString) {
    editorUi.selectRow(rowId);
    editorUi.panelOpen = true;
  }

  const rowHeaderColumn = $derived<RowHeaders>({
    prop: "__row_header__",
    size: 56,
    readonly: true,
    sortable: false,
    resizable: false,
    columnTemplate: () => "",
    cellTemplate: (h, props: CellTemplateProp) => {
      const row = props.model as GridSourceRow;
      if (row?._isGroup) return "";

      const label = String(row?._rowNumber ?? props.rowIndex + 1);
      const rowId = typeof row?._id === "string" ? row._id : null;

      // 行首悬停态：默认显示行号，鼠标悬停行首单元格时行号淡出、展开图标淡入。
      return h("div", { class: { "grid-row-head": true } }, [
        h("span", { class: { "grid-row-head__num": true } }, label),
        rowId
          ? h(
              "button",
              {
                class: { "grid-row-head__expand": true },
                type: "button",
                title: "展开详情",
                "aria-label": "展开详情",
                onClick: (event: MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openRecordDetail(rowId as RecordIdString);
                },
              },
              h(
                "svg",
                {
                  width: 15,
                  height: 15,
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  "stroke-width": 2,
                  "stroke-linecap": "round",
                  "stroke-linejoin": "round",
                  "aria-hidden": "true",
                },
                [
                  h("path", { d: "M15 3h6v6" }),
                  h("path", { d: "M10 14 21 3" }),
                  h("path", { d: "M9 21H3v-6" }),
                  h("path", { d: "M3 21l7-7" }),
                ],
              ),
            )
          : null,
      ]);
    },
  });

  /** 分组开启时按分组键插入分组分隔行，方便用户在表格内直接看见分组归属。 */
  const gridSource = $derived<GridSourceRow[]>(
    (() => {
      const rows = tableView.visibleRows.map((row) => ({ _id: row.id, ...row.values })) as GridSourceRow[];
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
          // 加列是 DDL：普通成员禁用（引擎层本就会拒，按钮态只是提示）。
          title: canWriteSharedStructure ? "添加一列" : "仅工作区管理员可添加字段",
          disabled: !canWriteSharedStructure || editorStore.saving,
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            void editorStore.addField();
          },
        },
        h("span", { class: { "grid-add-field-header__icon": true }, "aria-hidden": "true" }, "+"),
      ),
  });

  const gridColumns = $derived<ColumnRegular[]>(
    [
      ...tableView.visibleColumns.map((col) => {
        const meta = getFieldTypeMeta(col.fieldType);
        const iconPaths = getFieldTypeIconPaths(col.fieldType);
        const base: ColumnRegular = {
          prop: col.key,
          name: col.label,
          size: columnWidths[col.key] ?? GRID_COLUMN_WIDTH,
          columnTemplate: (h) =>
            h(
              "span",
              { class: { "grid-header-cell": true }, title: `${col.label}（${meta.label}）` },
              [
                h(
                  "svg",
                  {
                    class: { "grid-header-cell__icon": true },
                    width: 14,
                    height: 14,
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": 1.8,
                    "stroke-linecap": "round",
                    "stroke-linejoin": "round",
                    "aria-hidden": "true",
                  },
                  iconPaths.map((d) => h("path", { d })),
                ),
                h("span", { class: { "grid-header-cell__label": true } }, col.label),
              ],
            ),
        };
        if (col.fieldType === "date") {
          // 只读展示；内联 DatePicker 编辑器 → 07e。
          base.cellTemplate = (h, props: CellTemplateProp) => formatDateValue(props.model?.[col.key], col.dateFormat);
        }
        if (col.fieldType === "reference") {
          base.cellTemplate = (h, props: CellTemplateProp) => {
            const raw = props.model?.[col.key];
            const ids: RecordIdString[] = Array.isArray(raw)
              ? raw.filter((v): v is string => typeof v === "string")
              : typeof raw === "string" && raw
                ? [raw]
                : [];
            if (!ids.length) return "";
            // 通过 ref 在挂载后把 ReferenceCell（展示目标记录展示值）挂进 host 元素。
            return h("div", {
              class: { "grid-reference-cell-host": true },
              ref: (el: HTMLElement | null) => {
                if (!el) return;
                const host = el as HTMLElement & { __refDispose?: () => void };
                host.__refDispose?.();
                host.__refDispose = mountReferenceCellInto(el, ids);
              },
            });
          };
          base.editor = createReferenceEditor(col) as unknown as ColumnRegular["editor"];
        }
        return base;
      }),
      addFieldColumn,
    ] satisfies ColumnRegular[],
  );

  const visibleGridRows = $derived(Math.max(gridSource.length, 8));
  const gridViewportWidth = $derived(
    GRID_ROW_HEADER_WIDTH +
      tableView.visibleColumns.reduce((sum, col) => sum + (columnWidths[col.key] ?? GRID_COLUMN_WIDTH), 0) +
      ADD_FIELD_WIDTH +
      1,
  );
  const gridViewportHeight = $derived(GRID_HEADER_HEIGHT + visibleGridRows * GRID_ROW_HEIGHT + 1);
  const tableStyle = $derived(`--grid-width:${gridViewportWidth}px; --grid-height:${gridViewportHeight}px; --add-row-height:${ADD_ROW_HEIGHT}px;`);

  let gridRef = $state<{
    getWebComponent: () => HTMLElement & {
      getFocused?: () => Promise<{ y?: number } | undefined>;
      getSource?: () => Promise<Array<Record<string, unknown>>>;
      refresh?: () => Promise<void> | void;
      rowHeaders?: RowHeaders | boolean;
    };
  } | null>(null);

  let cleanup: (() => void) | undefined;

  function syncRowHeaders() {
    const grid = gridRef?.getWebComponent();
    if (!grid) return;

    grid.rowHeaders = rowHeaderColumn;
    void grid.refresh?.();
  }

  onMount(() => {
    const grid = gridRef?.getWebComponent();
    if (!grid) return;
    syncRowHeaders();

    const beforePaste = (event: Event) => {
      const detail = (event as CustomEvent<{ parsed?: unknown[][] }>).detail;
      const parsed = detail?.parsed;
      if (parsed?.length) {
        editorUi.clipboardStatus = `检测到粘贴：${parsed.length} 行 × ${parsed[0]?.length ?? 0} 列`;
      }
    };

    const afterPaste = async () => {
      if (!canWriteEntityData) {
        editorUi.clipboardStatus = "当前不可写，粘贴未保存";
        return;
      }
      editorUi.clipboardStatus = "粘贴已应用,保存中…";
      const next = await grid.getSource?.();
      if (next?.length) {
        const ok = await tableView.actions.saveFromSource(next.filter((r) => !r._isGroup));
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
      tableView.actions.selectRow(rowId as RecordIdString);
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
        const column = tableView.visibleColumns[index];
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
        openRowMenu(rowId as RecordIdString, mouseEvent.clientX, mouseEvent.clientY);
      }
    };

    let hoveredRowHead: HTMLElement | null = null;
    const setHoveredRowHead = (next: HTMLElement | null) => {
      if (hoveredRowHead === next) return;
      hoveredRowHead?.classList.remove("is-hovered");
      hoveredRowHead = next;
      hoveredRowHead?.classList.add("is-hovered");
    };

    const onRowHeadOver = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      setHoveredRowHead(target.closest(".grid-row-head"));
    };

    const onRowHeadOut = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget;
      if (related instanceof HTMLElement && hoveredRowHead?.contains(related)) return;
      setHoveredRowHead(null);
    };

    grid.addEventListener("beforepasteapply", beforePaste);
    grid.addEventListener("afterpasteapply", afterPaste);
    grid.addEventListener("contextmenu", onContextMenu, true);
    grid.addEventListener("mousedown", onCellMouseDown, true);
    grid.addEventListener("mouseover", onRowHeadOver, true);
    grid.addEventListener("mouseout", onRowHeadOut, true);
    document.addEventListener("mousedown", onRowMenuBackdrop, true);

    cleanup = () => {
      grid.removeEventListener("beforepasteapply", beforePaste);
      grid.removeEventListener("afterpasteapply", afterPaste);
      grid.removeEventListener("contextmenu", onContextMenu, true);
      grid.removeEventListener("mousedown", onCellMouseDown, true);
      grid.removeEventListener("mouseover", onRowHeadOver, true);
      grid.removeEventListener("mouseout", onRowHeadOut, true);
      document.removeEventListener("mousedown", onRowMenuBackdrop, true);
      setHoveredRowHead(null);
    };
  });

  onDestroy(() => cleanup?.());

  async function handleAfterEdit() {
    if (!canWriteEntityData) return;
    const next = await gridRef?.getWebComponent()?.getSource?.();
    if (next?.length) {
      const ok = await tableView.actions.saveFromSource(next.filter((r) => !r._isGroup));
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
      tableView.actions.selectRow(sourceRow!._id as RecordIdString);
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
    tableView.actions.selectRow(rowId);
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
    openRecordDetail(rowMenu.rowId);
    closeRowMenu();
  }

  function duplicateRecord() {
    if (!canWriteEntityData || !rowMenu.rowId) return;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    tableView.actions.duplicateRowAsDraft(targetId);
  }

  function insertRows(direction: "above" | "below") {
    if (!canWriteEntityData || !rowMenu.rowId) return;
    const count = direction === "above" ? rowMenu.insertAboveCount : rowMenu.insertBelowCount;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    tableView.actions.insertBlankRows(targetId, count, direction);
  }

  async function deleteRecord() {
    if (!canWriteEntityData || !rowMenu.rowId) return;
    const targetId = rowMenu.rowId;
    closeRowMenu();
    await tableView.actions.deleteRows([targetId]);
  }

  function appendRowAtEnd() {
    if (!canWriteEntityData || !editorStore.activeSheetId) return;
    tableView.actions.insertBlankRows(null, 1, "end");
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
          rowHeaders={true}
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
          readonly={!canWriteEntityData}
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
        disabled={!canWriteEntityData || !editorStore.activeSheetId}
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
      <ExternalLink size={13} />
      <span>展开记录</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onclick={duplicateRecord} disabled={!canWriteEntityData}>
      <Copy size={13} />
      <span>创建副本</span>
    </button>
    <button
      type="button"
      class="menu-row"
      role="menuitem"
      onclick={() => insertRows("above")}
      disabled={!canWriteEntityData}
    >
      <ArrowUp size={13} />
      <span>在上方插入</span>
      <input
        type="number"
        min="1"
        max="200"
        bind:value={rowMenu.insertAboveCount}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        onmousedown={(e) => e.stopPropagation()}
        disabled={!canWriteEntityData}
      />
      <span class="muted">行</span>
    </button>
    <button
      type="button"
      class="menu-row"
      role="menuitem"
      onclick={() => insertRows("below")}
      disabled={!canWriteEntityData}
    >
      <ArrowDown size={13} />
      <span>在下方插入</span>
      <input
        type="number"
        min="1"
        max="200"
        bind:value={rowMenu.insertBelowCount}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        onmousedown={(e) => e.stopPropagation()}
        disabled={!canWriteEntityData}
      />
      <span class="muted">行</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" disabled>
      <Link size={13} />
      <span>获取分享链接</span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item danger" role="menuitem" onclick={deleteRecord} disabled={!canWriteEntityData}>
      <Trash2 size={13} />
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
      <strong>{tableView.getColumn(editorUi.fieldMenu.fieldKey)?.label ?? "字段"}</strong>
      <span>{editorUi.fieldMenu.fieldKey}</span>
    </div>
    <button class="menu-item" role="menuitem" onclick={openFieldEditor}>
      <span>字段设置</span>
      <Settings size={13} />
    </button>
    <button class="menu-item" role="menuitem" onclick={hideField}>
      <span>隐藏字段</span>
      <Eye size={13} />
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
    background: var(--bg);
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
    background: var(--surface);
    color: var(--text-3);
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .03);
    transition: background .16s ease, color .16s ease, box-shadow .16s ease;
  }

  .grid-footer:hover:not(:disabled) {
    background: var(--primary-light);
    color: var(--primary);
    box-shadow: inset 0 0 0 1px rgba(47, 122, 76, .12);
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
    border: 1px solid var(--border-dark);
    border-radius: 999px;
    background: var(--surface);
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
    --revo-grid-row-hover: var(--soft);
    --revo-grid-focused-bg: var(--primary-light);
    --revo-grid-header-bg: var(--soft);
    --revo-grid-text: var(--text-2);
    border: 0;
  }

  :global(revo-grid .rgCell),
  :global(revo-grid .rgHeaderCell) {
    font-size: 12px;
  }

  :global(revo-grid .grid-header-cell) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  :global(revo-grid .grid-header-cell__icon) {
    flex: 0 0 auto;
    color: var(--text-3);
  }

  :global(revo-grid .grid-header-cell__label) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }

  :global(revo-grid .grid-reference-editor-host) {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    padding: 0 4px;
    background: var(--surface);
    box-shadow: inset 0 0 0 2px var(--primary);
  }

  :global(revo-grid .grid-reference-cell-host) {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  :global(revo-grid .grid-add-field-header) {
    display: inline-flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition: background .16s ease, color .16s ease;
  }

  :global(revo-grid .grid-add-field-header:hover:not(:disabled)) {
    background: var(--primary-light);
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

  /* 行首单元格：默认显示行号，悬停行首时行号淡出、展开图标淡入并可点击。 */
  :global(revo-grid .grid-row-head) {
    position: relative;
    display: flex;
    width: calc(100% + 24px);
    height: 100%;
    margin: 0 -12px;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
  }

  :global(revo-grid .grid-row-head__num) {
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    transition: opacity .14s ease;
  }

  :global(revo-grid .grid-row-head__expand) {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity .14s ease, color .14s ease, background .14s ease;
  }

  :global(revo-grid .grid-row-head:hover .grid-row-head__num),
  :global(revo-grid .grid-row-head.is-hovered .grid-row-head__num),
  :global(revo-grid .grid-row-head:focus-within .grid-row-head__num) {
    opacity: 0;
  }

  :global(revo-grid .grid-row-head:hover .grid-row-head__expand),
  :global(revo-grid .grid-row-head.is-hovered .grid-row-head__expand),
  :global(revo-grid .grid-row-head:focus-within .grid-row-head__expand) {
    opacity: 1;
    pointer-events: auto;
  }

  :global(revo-grid .grid-row-head__expand:hover) {
    background: var(--primary-light);
    color: var(--primary);
  }

  .field-menu {
    position: fixed;
    z-index: 60;
    display: grid;
    min-width: 188px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 18px 42px rgba(34, 30, 23, .16);
    backdrop-filter: blur(12px);
  }

  .field-menu-head {
    display: grid;
    gap: 3px;
    padding: 4px 6px 8px;
    border-bottom: 1px solid var(--border);
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
    background: var(--primary-light);
    color: var(--primary);
  }

  .row-menu {
    position: fixed;
    z-index: 60;
    display: grid;
    min-width: 220px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 18px 42px rgba(34, 30, 23, .16);
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
    background: var(--primary-light);
    color: var(--primary);
  }

  .row-menu .menu-item:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .row-menu .menu-item.danger {
    color: var(--error, #c0492b);
  }

  .row-menu .menu-item.danger:hover:not(:disabled) {
    background: var(--error-bg, #f6e3dc);
    color: var(--error, #c0492b);
  }

  .row-menu .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
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
    background: var(--primary-light);
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
