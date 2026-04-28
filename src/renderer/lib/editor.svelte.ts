import { appApi } from "./app-api";
import type {
  WorkbookDataDTO,
  GridColumnDef,
  GridRow,
  SheetSummaryDTO,
  RecordIdString,
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
  });

  async function loadWorkbook(workbookId: string, sheetId?: string) {
    state.loading = true;
    state.error = null;
    state.data = null;
    try {
      const res = await appApi.getWorkbookData(workbookId, sheetId);
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

  async function switchSheet(sheetId: string) {
    if (!state.data) return;
    await loadWorkbook(state.data.workbook.id, sheetId);
  }

  async function saveRows(patches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>) {
    if (!state.activeSheetId) return;
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
      } else {
        state.saveError = res.message;
      }
    } catch (err) {
      state.saveError = String(err);
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
  async function saveFromSource(source: Array<Record<string, unknown>>) {
    if (!state.activeSheetId || !state.columns.length) return;
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

    await saveRows(patches);
  }

  function reset() {
    state.data = null;
    state.activeSheetId = null;
    state.columns = [];
    state.rows = [];
    state.error = null;
    state.saveError = null;
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
    loadWorkbook,
    switchSheet,
    saveRows,
    saveFromSource,
    renameWorkbook,
    updateFields,
    reset,
  };
}

export const editorStore = createEditorStore();
