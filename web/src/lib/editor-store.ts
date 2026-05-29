import {
  coerceGridFieldValue,
  storedColumnToDTO,
  validateGridFieldValue,
  type StoredGridFieldDef,
} from "@surreal-ck/shared/field-schema";
import type {
  FilterClause,
  GridColumnDef,
  GridRow,
  RecordIdString,
  SortClause,
  ViewParams,
} from "@surreal-ck/shared/rpc.types";
import type { SurrealConn } from "./surreal";
import { deleteRows as deleteRowsDirect, loadSheet, saveCells, subscribeLive, type SheetRef } from "./workbook-data";
import { isDraftRowId, recordDrafts } from "./record-drafts";

export { isDraftRowId } from "./record-drafts";

export type TableViewRow = GridRow & { rowNumber: number };

export type TableViewCardRenderers = {
  title: GridColumnDef | null;
  secondary: GridColumnDef | null;
  status: GridColumnDef | null;
  amount: GridColumnDef | null;
  date: GridColumnDef | null;
};

export type TableViewActions = {
  selectRow: (id: RecordIdString | null) => void;
  openRecord: (id: RecordIdString) => void;
  saveRows: (patches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>) => Promise<boolean>;
  saveFromSource: (source: Array<Record<string, unknown>>) => Promise<boolean>;
  deleteRows: (ids: Array<RecordIdString | string>) => Promise<boolean>;
  insertBlankRows: (
    targetRowId: RecordIdString | string | null,
    count: number,
    position: "above" | "below" | "end",
  ) => boolean;
  duplicateRowAsDraft: (sourceRowId: RecordIdString | string) => boolean;
};

export type TableViewAdapter = {
  visibleRows: TableViewRow[];
  visibleColumns: GridColumnDef[];
  renderers: TableViewCardRenderers;
  actions: TableViewActions;
  getColumn: (key: string | null | undefined) => GridColumnDef | null;
  coerceValue: (column: GridColumnDef, value: unknown) => unknown;
  validateValue: (column: GridColumnDef, value: unknown) => string | null;
  emptyValues: (columns?: GridColumnDef[]) => Record<string, unknown>;
};

/** 一个 sheet 的展示元数据；切 sheet 时整体替换。 */
export type SheetMeta = {
  id: RecordIdString;
  label: string;
  tableName: string;
  columns: GridColumnDef[];
};

export type EditorState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveError: string | null;
  workbookId: RecordIdString | null;
  activeSheetId: RecordIdString | null;
  sheets: SheetMeta[];
  columns: GridColumnDef[];
  rows: GridRow[];
  viewParams: ViewParams;
  /** 按 sheetId 分桶的 draft 行：切 sheet 时保留，离开工作簿时整体丢弃。 */
  draftsBySheet: Record<string, GridRow[]>;
};

/** `.svelte.ts` 镜像进 runes 的快照；不含派生视图（由 runes 层调 buildTableViewAdapter）。 */
export type EditorSnapshot = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveError: string | null;
  activeSheetId: RecordIdString | null;
  sheets: SheetMeta[];
  columns: GridColumnDef[];
  rows: GridRow[];
  viewParams: ViewParams;
  draftsBySheet: Record<string, GridRow[]>;
};

export type EditorDeps = {
  getConn: () => SurrealConn;
  /** 镜像进 runes，使组件响应式更新。纯逻辑层不依赖它。 */
  onChange?: (snapshot: EditorSnapshot) => void;
  /** UI 选择 / 打开记录的副作用；默认 no-op，避免与 UI 层耦合。 */
  selectRow?: (id: RecordIdString | null) => void;
  openRecord?: (id: RecordIdString) => void;
};

const PAGE: { limit: number; start: number } = { limit: 500, start: 0 };

const EMPTY_VIEW_PARAMS: ViewParams = {
  filters: [],
  filterMode: "and",
  sorts: [],
  hiddenFields: [],
  groupBy: null,
};

export type EditorStore = ReturnType<typeof createEditorStore>;

export function createEditorStore(deps: EditorDeps) {
  const state: EditorState = {
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    workbookId: null,
    activeSheetId: null,
    sheets: [],
    columns: [],
    rows: [],
    viewParams: { ...EMPTY_VIEW_PARAMS },
    draftsBySheet: {},
  };

  let unsubscribeLive: (() => void) | null = null;

  function emit(): void {
    deps.onChange?.({
      loading: state.loading,
      saving: state.saving,
      error: state.error,
      saveError: state.saveError,
      activeSheetId: state.activeSheetId,
      sheets: state.sheets,
      columns: state.columns,
      rows: state.rows,
      viewParams: state.viewParams,
      draftsBySheet: state.draftsBySheet,
    });
  }

  function sheetRef(): SheetRef | null {
    const meta = state.sheets.find((s) => s.id === state.activeSheetId);
    if (!meta) return null;
    return { tableName: meta.tableName, columns: meta.columns };
  }

  /** 把 state.rows 中持久化部分写回 bucket（不动 drafts），保持 rows 与 bucket 一致。 */
  function syncDraftBucket(): void {
    state.draftsBySheet = recordDrafts.syncBucket(state.activeSheetId, state.rows, state.draftsBySheet);
  }

  function stopLive(): void {
    unsubscribeLive?.();
    unsubscribeLive = null;
  }

  async function startLive(): Promise<void> {
    const ref = sheetRef();
    if (!ref) return;
    unsubscribeLive = await subscribeLive(deps.getConn(), ref, {
      onUpsert: (row) => {
        const idx = state.rows.findIndex((r) => r.id === row.id);
        if (idx === -1) state.rows = [...state.rows, row];
        else state.rows = state.rows.map((r) => (r.id === row.id ? row : r));
        emit();
      },
      onRemove: (id) => {
        state.rows = state.rows.filter((r) => r.id !== id);
        emit();
      },
    });
  }

  /** 读 workbook 下所有 sheet，挑选 active sheet，派生 columns 并加载行 + 订阅 LIVE。 */
  async function loadWorkbook(workbookId: string, sheetId?: string): Promise<void> {
    const switchingWorkbook = state.workbookId !== workbookId;
    if (switchingWorkbook) state.draftsBySheet = {};
    stopLive();
    state.loading = true;
    state.error = null;
    state.workbookId = workbookId as RecordIdString;
    emit();
    try {
      const sheets = await fetchSheets(deps.getConn(), workbookId);
      if (!sheets.length) {
        state.sheets = [];
        state.activeSheetId = null;
        state.columns = [];
        state.rows = [];
        state.error = "该工作簿下没有工作表";
        return;
      }
      state.sheets = sheets;
      const active = sheets.find((s) => s.id === sheetId) ?? sheets[0];
      state.activeSheetId = active.id;
      state.columns = active.columns;
      const ref: SheetRef = { tableName: active.tableName, columns: active.columns };
      const rows = await loadSheet(deps.getConn(), ref, state.viewParams, PAGE);
      state.rows = recordDrafts.rowsWithDrafts(active.id, rows, state.draftsBySheet);
      await startLive();
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  /** 仅重查当前 sheet 的行，不动 sheet/columns/viewParams 结构。 */
  async function reloadRows(): Promise<void> {
    const ref = sheetRef();
    if (!ref || !state.activeSheetId) return;
    syncDraftBucket();
    state.loading = true;
    state.error = null;
    emit();
    try {
      const rows = await loadSheet(deps.getConn(), ref, state.viewParams, PAGE);
      state.rows = recordDrafts.rowsWithDrafts(state.activeSheetId, rows, state.draftsBySheet);
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
      emit();
    }
  }

  async function switchSheet(sheetId: string): Promise<void> {
    if (!state.workbookId) return;
    syncDraftBucket();
    state.viewParams = { ...EMPTY_VIEW_PARAMS };
    await loadWorkbook(state.workbookId, sheetId);
  }

  async function setFilters(
    filters: FilterClause[],
    filterMode: "and" | "or" = state.viewParams.filterMode ?? "and",
  ): Promise<void> {
    state.viewParams = { ...state.viewParams, filters, filterMode };
    await reloadRows();
  }

  async function setSorts(sorts: SortClause[]): Promise<void> {
    state.viewParams = { ...state.viewParams, sorts };
    await reloadRows();
  }

  function setHiddenFields(hiddenFields: string[]): void {
    state.viewParams = { ...state.viewParams, hiddenFields };
    emit();
  }

  function setGroupBy(groupBy: string | null): void {
    state.viewParams = { ...state.viewParams, groupBy };
    emit();
  }

  /** 写持久化行（更新真实行 / 新建持久化行）；不接受 draft id。 */
  async function saveRows(
    rawPatches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>,
  ): Promise<boolean> {
    const ref = sheetRef();
    if (!ref) return false;
    // 带 id 的部分 patch 与现有行合并后再校验/写入，避免必填字段被误判为缺失。
    const rowById = new Map(state.rows.map((r) => [r.id, r]));
    const patches = rawPatches.map((p) => {
      if (!p.id) return p;
      const existing = rowById.get(p.id);
      return existing ? { id: p.id, values: { ...existing.values, ...p.values } } : p;
    });
    const validationError = validatePatches(patches, state.columns);
    if (validationError) {
      state.saveError = validationError;
      emit();
      return false;
    }
    state.saving = true;
    state.saveError = null;
    emit();
    try {
      const result = await saveCells(deps.getConn(), ref, patches);
      if (!result.ok) {
        state.saveError = result.message;
        return false;
      }
      // 写库成功后用最新值就地合并（LIVE 会再补一次，幂等）。
      const byId = new Map(patches.filter((p) => p.id).map((p) => [p.id as string, p.values]));
      state.rows = state.rows.map((row) =>
        byId.has(row.id) ? { ...row, values: { ...row.values, ...byId.get(row.id) } } : row,
      );
      return true;
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
      emit();
    }
  }

  /** 删行：draft 本地丢弃，持久化行走 deleteRows（DELETE by RecordId）。 */
  async function deleteRows(ids: Array<RecordIdString | string>): Promise<boolean> {
    if (!state.activeSheetId || !ids.length) return false;
    const drafts = ids.filter((id) => isDraftRowId(id));
    const persisted = ids.filter((id) => !isDraftRowId(id)) as RecordIdString[];

    if (drafts.length) {
      const next = recordDrafts.discardIds(state.activeSheetId, state.rows, state.draftsBySheet, drafts);
      state.rows = next.rows;
      state.draftsBySheet = next.draftsBySheet;
      emit();
    }

    if (!persisted.length) return true;

    state.saving = true;
    state.saveError = null;
    emit();
    try {
      const result = await deleteRowsDirect(deps.getConn(), persisted);
      if (!result.ok) {
        state.saveError = result.message;
        return false;
      }
      const removed = new Set<string>(persisted);
      state.rows = state.rows.filter((row) => !removed.has(row.id));
      return true;
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
      emit();
    }
  }

  function insertBlankRows(
    targetRowId: RecordIdString | string | null,
    count: number,
    position: "above" | "below" | "end",
  ): boolean {
    const next = recordDrafts.insert(
      state.activeSheetId,
      state.rows,
      state.draftsBySheet,
      state.columns,
      targetRowId,
      count,
      position,
    );
    if (!next) return false;
    state.rows = next.rows;
    state.draftsBySheet = next.draftsBySheet;
    emit();
    return true;
  }

  function duplicateRowAsDraft(sourceRowId: RecordIdString | string): boolean {
    const next = recordDrafts.duplicate(
      state.activeSheetId,
      state.rows,
      state.draftsBySheet,
      state.columns,
      sourceRowId,
    );
    if (!next) return false;
    state.rows = next.rows;
    state.draftsBySheet = next.draftsBySheet;
    emit();
    return true;
  }

  /** 合并 draft 新值并尝试晋升：校验通过 → createRecord 写库换真实 id；否则只更新内存 draft。 */
  async function commitDraftEdit(
    draftId: string,
    values: Record<string, unknown>,
  ): Promise<{ promoted: boolean; newId?: RecordIdString }> {
    const ref = sheetRef();
    if (!ref || !state.activeSheetId) return { promoted: false };
    const merged = recordDrafts.merge(state.activeSheetId, state.rows, state.draftsBySheet, draftId, values);
    if (!merged) return { promoted: false };
    state.rows = merged.rows;
    state.draftsBySheet = merged.draftsBySheet;
    emit();

    const probe = [{ values: { ...values } }];
    if (validatePatches(probe, state.columns)) {
      // 留作 draft，不算错误——这正是 draft 的目的。
      return { promoted: false };
    }

    state.saving = true;
    state.saveError = null;
    emit();
    try {
      const conn = deps.getConn();
      const created = await conn.createRecord<{ id: unknown } & Record<string, unknown>>(
        ref.tableName,
        probe[0].values,
      );
      const promotedRow = recordRowToGrid(created, state.columns);
      const next = recordDrafts.promote(state.activeSheetId, state.rows, state.draftsBySheet, draftId, promotedRow);
      state.rows = next.rows;
      state.draftsBySheet = next.draftsBySheet;
      return { promoted: true, newId: promotedRow.id };
    } catch (err) {
      state.saveError = String(err);
      return { promoted: false };
    } finally {
      state.saving = false;
      emit();
    }
  }

  /**
   * 接收 grid 全量 source（含 draft + persisted），diff 出变更行并分流：
   * persisted → saveRows；draft → commitDraftEdit（达标晋升 / 否则只更新内存）。
   * 返回值仅表示「持久化是否有错」；draft 校验未通过不算失败。
   */
  async function saveFromSource(source: Array<Record<string, unknown>>): Promise<boolean> {
    if (!state.activeSheetId || !state.columns.length) return false;
    const { persistedPatches, draftEdits } = recordDrafts.diffSource(source, state.rows, state.columns);

    let ok = true;
    if (persistedPatches.length) {
      if (!(await saveRows(persistedPatches))) ok = false;
    }
    for (const edit of draftEdits) {
      await commitDraftEdit(edit.draftId, edit.values);
    }
    return ok;
  }

  /** 切 workspace / 离开工作簿：丢弃 drafts、退订 LIVE、状态归零。 */
  function reset(): void {
    stopLive();
    state.workbookId = null;
    state.activeSheetId = null;
    state.sheets = [];
    state.columns = [];
    state.rows = [];
    state.error = null;
    state.saveError = null;
    state.viewParams = { ...EMPTY_VIEW_PARAMS };
    state.draftsBySheet = {};
    emit();
  }

  function getVisibleColumns(): GridColumnDef[] {
    const hidden = new Set(state.viewParams.hiddenFields ?? []);
    return state.columns.filter((col) => !hidden.has(col.key));
  }

  function getVisibleRows(): TableViewRow[] {
    return state.rows.map((row, index) => ({ ...row, rowNumber: index + 1 }));
  }

  function getColumn(key: string | null | undefined): GridColumnDef | null {
    if (!key) return null;
    return state.columns.find((col) => col.key === key) ?? null;
  }

  function emptyValues(columns: GridColumnDef[] = state.columns): Record<string, unknown> {
    return Object.fromEntries(columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]));
  }

  function tableViewAdapter(): TableViewAdapter {
    const visibleColumns = getVisibleColumns();
    return {
      visibleRows: getVisibleRows(),
      visibleColumns,
      renderers: deriveRenderers(visibleColumns),
      actions: {
        selectRow: (id) => deps.selectRow?.(id),
        openRecord: (id) => deps.openRecord?.(id),
        saveRows,
        saveFromSource,
        deleteRows,
        insertBlankRows,
        duplicateRowAsDraft,
      },
      getColumn,
      coerceValue: (column, value) => coerceGridFieldValue(value, column),
      validateValue: (column, value) => validateGridFieldValue(value, column)[0] ?? null,
      emptyValues,
    };
  }

  return {
    get loading() { return state.loading; },
    get saving() { return state.saving; },
    get error() { return state.error; },
    get saveError() { return state.saveError; },
    get activeSheetId() { return state.activeSheetId; },
    get sheets() { return state.sheets; },
    get columns() { return state.columns; },
    get rows() { return state.rows; },
    get viewParams(): ViewParams { return state.viewParams; },
    get visibleColumns(): GridColumnDef[] { return getVisibleColumns(); },
    get tableViewAdapter(): TableViewAdapter { return tableViewAdapter(); },
    get pendingDraftCount(): number { return recordDrafts.count(state.draftsBySheet); },
    loadWorkbook,
    reloadRows,
    switchSheet,
    setFilters,
    setSorts,
    setHiddenFields,
    setGroupBy,
    saveRows,
    saveFromSource,
    deleteRows,
    insertBlankRows,
    duplicateRowAsDraft,
    commitDraftEdit,
    reset,
  };
}

/** entity 行上由 schema 维护、不属于业务列的系统字段。 */
const SYSTEM_FIELDS = new Set(["id", "workspace", "created_by", "created_at", "updated_at"]);

/** 读 workbook 下所有 sheet 记录，按 table_name + column_defs 派生展示元数据。 */
async function fetchSheets(conn: SurrealConn, workbookId: string): Promise<SheetMeta[]> {
  const records = await conn.query<Record<string, unknown>>(
    "SELECT * FROM sheet WHERE workbook = $wb ORDER BY created_at ASC",
    { wb: workbookId },
  );
  return records.map((rec) => ({
    id: String(rec.id) as RecordIdString,
    label: typeof rec.label === "string" ? rec.label : "",
    tableName: String(rec.table_name),
    columns: ((rec.column_defs as StoredGridFieldDef[] | undefined) ?? []).map(storedColumnToDTO),
  }));
}

/** createRecord 返回的原始记录裁成 GridRow（剔系统字段、只留已知列）。 */
function recordRowToGrid(record: Record<string, unknown>, columns: GridColumnDef[]): GridRow {
  const known = new Set(columns.map((c) => c.key));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    if (known.has(key)) values[key] = value;
  }
  return { id: String(record.id) as RecordIdString, values };
}

/** 隐藏字段过滤后的可见列。供 runes 层从快照派生用。 */
export function visibleColumnsFrom(columns: GridColumnDef[], hiddenFields: string[] | undefined): GridColumnDef[] {
  const hidden = new Set(hiddenFields ?? []);
  return columns.filter((col) => !hidden.has(col.key));
}

/** 给行加上 1-based rowNumber。供 runes 层从快照派生用。 */
export function visibleRowsFrom(rows: GridRow[]): TableViewRow[] {
  return rows.map((row, index) => ({ ...row, rowNumber: index + 1 }));
}

export { deriveRenderers };

function deriveRenderers(columns: GridColumnDef[]): TableViewCardRenderers {
  return {
    title: columns[0] ?? null,
    secondary: columns[1] ?? null,
    status:
      columns.find((col) => /status|状态/i.test(col.key) || /状态/.test(col.label)) ??
      columns.find((col) => col.options?.length) ??
      null,
    amount: columns.find((col) => col.fieldType === "number" || col.fieldType === "decimal") ?? null,
    date: columns.find((col) => col.fieldType === "date") ?? null,
  };
}

function validatePatches(
  patches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>,
  columns: GridColumnDef[],
): string | null {
  for (const [rowIndex, patch] of patches.entries()) {
    for (const column of columns) {
      const coerced = coerceGridFieldValue(patch.values[column.key], column);
      const errors = validateGridFieldValue(coerced, column);
      if (errors.length) {
        return `第 ${rowIndex + 1} 行「${column.label}」${errors[0]}`;
      }
      patch.values[column.key] = coerced;
    }
  }
  return null;
}
