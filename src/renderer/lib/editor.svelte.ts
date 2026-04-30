import { appApi } from "./app-api";
import { coerceGridFieldValue, validateGridFieldValue } from "../../shared/field-schema";
import type {
  FilterClause,
  GridColumnDef,
  GridRow,
  RecordIdString,
  SheetSummaryDTO,
  SortClause,
  ViewParams,
  WorkbookDataDTO,
} from "../../shared/rpc.types";

type EditorState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  saveError: string | null;
  data: WorkbookDataDTO | null;
  activeSheetId: string | null;
  columns: GridColumnDef[];
  rows: GridRow[];
  viewParams: ViewParams;
};

const EMPTY_VIEW_PARAMS: ViewParams = {
  filters: [],
  filterMode: "and",
  sorts: [],
  hiddenFields: [],
  groupBy: null,
};

function createEditorStore() {
  let state = $state<EditorState>({
    loading: false,
    saving: false,
    error: null,
    saveError: null,
    data: null,
    activeSheetId: null,
    columns: [],
    rows: [],
    viewParams: { ...EMPTY_VIEW_PARAMS },
  });

  async function loadWorkbook(workbookId: string, sheetId?: string) {
    state.loading = true;
    state.error = null;
    state.data = null;
    try {
      const res = await appApi.getWorkbookData(workbookId, sheetId, state.viewParams);
      if (res.ok) {
        state.data = res.data;
        state.activeSheetId = res.data.activeSheetId;
        state.columns = res.data.columns;
        state.rows = res.data.rows;
      } else {
        state.error = res.message;
      }
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  /** 仅重新加载行数据，不重置当前 sheet/columns/视图参数。用于查询变更后的局部刷新。 */
  async function reloadRows() {
    if (!state.data || !state.activeSheetId) return;
    state.loading = true;
    state.error = null;
    try {
      const res = await appApi.getWorkbookData(state.data.workbook.id, state.activeSheetId, state.viewParams);
      if (res.ok) {
        state.rows = res.data.rows;
      } else {
        state.error = res.message;
      }
    } catch (err) {
      state.error = String(err);
    } finally {
      state.loading = false;
    }
  }

  async function switchSheet(sheetId: string) {
    if (!state.data) return;
    state.viewParams = { ...EMPTY_VIEW_PARAMS };
    await loadWorkbook(state.data.workbook.id, sheetId);
  }

  async function setFilters(filters: FilterClause[], filterMode: "and" | "or" = state.viewParams.filterMode ?? "and") {
    state.viewParams = { ...state.viewParams, filters, filterMode };
    await reloadRows();
  }

  async function setSorts(sorts: SortClause[]) {
    state.viewParams = { ...state.viewParams, sorts };
    await reloadRows();
  }

  function setHiddenFields(hiddenFields: string[]) {
    state.viewParams = { ...state.viewParams, hiddenFields };
  }

  function setGroupBy(groupBy: string | null) {
    state.viewParams = { ...state.viewParams, groupBy };
  }

  async function saveRows(patches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>): Promise<boolean> {
    if (!state.activeSheetId) return false;
    const validationError = validatePatches(patches, state.columns);
    if (validationError) {
      state.saveError = validationError;
      return false;
    }
    state.saving = true;
    state.saveError = null;
    try {
      const res = await appApi.upsertRows(state.activeSheetId, patches);
      if (res.ok) {
        // 将服务端返回的行合并到本地 rows
        const upsertedMap = new Map(res.data.upserted.map((r) => [r.id, r]));
        const merged = state.rows.map((r) => upsertedMap.get(r.id) ?? r);
        // 新增的行（不在 merged 中）
        const existingIds = new Set(merged.map((r) => r.id));
        for (const r of res.data.upserted) {
          if (!existingIds.has(r.id)) merged.push(r);
        }
        state.rows = merged;
        return true;
      } else {
        state.saveError = res.message;
        return false;
      }
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  async function renameWorkbook(name: string): Promise<boolean> {
    if (!state.data) return false;
    state.saving = true;
    state.saveError = null;
    try {
      const res = await appApi.renameWorkbook(state.data.workbook.id, name);
      if (res.ok) {
        state.data = {
          ...state.data,
          workbook: res.data.workbook,
        };
        return true;
      }
      state.saveError = res.message;
      return false;
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  async function updateFields(columns: GridColumnDef[]): Promise<boolean> {
    if (!state.activeSheetId || !state.data) return false;
    state.saving = true;
    state.saveError = null;
    try {
      const res = await appApi.updateSheetFields(state.activeSheetId, columns);
      if (res.ok) {
        const sheets = state.data.sheets.map((sheet) => sheet.id === res.data.sheet.id ? res.data.sheet : sheet);
        state.columns = res.data.columns;
        state.data = {
          ...state.data,
          sheets,
          columns: res.data.columns,
        };
        state.rows = state.rows.map((row) => ({
          ...row,
          values: Object.fromEntries(Object.entries(row.values).filter(([key]) => res.data.columns.some((col) => col.key === key))),
        }));
        return true;
      }
      state.saveError = res.message;
      return false;
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  /** 从 Grid 完整 source 数组生成 upsert patches，用于 afterpasteapply / afteredit */
  async function saveFromSource(source: Array<Record<string, unknown>>): Promise<boolean> {
    if (!state.activeSheetId || !state.columns.length) return false;
    const colKeys = new Set(state.columns.map((c) => c.key));

    const byId = new Map(state.rows.map((row) => [row.id, row]));
    const patches = source.map((raw) => {
      const rawId = typeof raw._id === "string" ? raw._id : undefined;
      const existing = rawId ? byId.get(rawId) : undefined;
      const values: Record<string, unknown> = {};
      for (const k of colKeys) {
        if (k in raw) values[k] = raw[k];
      }
      return { id: existing?.id, values };
    });

    return saveRows(patches);
  }

  function reset() {
    state.data = null;
    state.activeSheetId = null;
    state.columns = [];
    state.rows = [];
    state.error = null;
    state.saveError = null;
    state.viewParams = { ...EMPTY_VIEW_PARAMS };
  }

  return {
    get loading() { return state.loading; },
    get saving() { return state.saving; },
    get error() { return state.error; },
    get saveError() { return state.saveError; },
    get data() { return state.data; },
    get activeSheetId() { return state.activeSheetId; },
    get columns() { return state.columns; },
    get rows() { return state.rows; },
    get sheets(): SheetSummaryDTO[] { return state.data?.sheets ?? []; },
    get workbookName(): string { return state.data?.workbook.name ?? ""; },
    get viewParams(): ViewParams { return state.viewParams; },
    /** 隐藏字段过滤后的可见列；视图组件统一消费此入口 */
    get visibleColumns(): GridColumnDef[] {
      const hidden = new Set(state.viewParams.hiddenFields ?? []);
      return state.columns.filter((col) => !hidden.has(col.key));
    },
    loadWorkbook,
    reloadRows,
    switchSheet,
    saveRows,
    saveFromSource,
    renameWorkbook,
    updateFields,
    setFilters,
    setSorts,
    setHiddenFields,
    setGroupBy,
    reset,
  };
}

export const editorStore = createEditorStore();

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
