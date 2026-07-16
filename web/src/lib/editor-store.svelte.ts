import type {
  FilterClause,
  GridColumnDef,
  RecordIdString,
  SortClause,
  ViewParams,
} from "@surreal-ck/shared/rpc.types";
import {
  coerceGridFieldValue,
  validateGridFieldValue,
} from "@surreal-ck/shared/field-schema";
import { getSurreal } from "./surreal";
import {
  createEditorStore,
  deriveRenderers,
  visibleColumnsFrom,
  visibleRowsFrom,
  type EditorSnapshot,
  type SheetMeta,
  type TableViewAdapter,
  type WorkbookMeta,
} from "./editor-store";
import type { ImportCsvRowsInput } from "./data-table-runtime";

export { isDraftRowId } from "./record-drafts";
export type {
  TableViewAdapter,
  TableViewRow,
  TableViewActions,
  TableViewCardRenderers,
  SheetMeta,
  WorkbookMeta,
} from "./editor-store";

/**
 * Reactive mirror of the pure {@link createEditorStore}. The logic layer
 * (unit-tested in editor-store.test.ts) holds the real state and emits
 * snapshots; this file republishes them into Svelte 5 runes so components
 * update, and rebuilds the table-view adapter from the runes snapshot.
 *
 * 这是后续所有组件迁移的唯一 seam：组件只 import `editorStore`，不直接碰数据层。
 */
const reactive = $state<EditorSnapshot>({
  loading: false,
  saving: false,
  error: null,
  saveError: null,
  workbook: null,
  activeSheetId: null,
  sheets: [],
  columns: [],
  rows: [],
  viewParams: { filters: [], filterMode: "and", sorts: [], hiddenFields: [], groupBy: null },
  draftsBySheet: {},
});

const store = createEditorStore({
  getConn: getSurreal,
  onChange(snapshot) {
    reactive.loading = snapshot.loading;
    reactive.saving = snapshot.saving;
    reactive.error = snapshot.error;
    reactive.saveError = snapshot.saveError;
    reactive.workbook = snapshot.workbook;
    reactive.activeSheetId = snapshot.activeSheetId;
    reactive.sheets = snapshot.sheets;
    reactive.columns = snapshot.columns;
    reactive.rows = snapshot.rows;
    reactive.viewParams = snapshot.viewParams;
    reactive.draftsBySheet = snapshot.draftsBySheet;
  },
});

function pendingDraftCount(): number {
  return Object.values(reactive.draftsBySheet).reduce((sum, list) => sum + list.length, 0);
}

/** 从 runes 快照派生的表视图 seam；组件统一消费此入口。actions 直接复用纯逻辑层方法。 */
function tableViewAdapter(): TableViewAdapter {
  const visibleColumns = visibleColumnsFrom(reactive.columns, reactive.viewParams.hiddenFields);
  return {
    visibleRows: visibleRowsFrom(reactive.rows),
    visibleColumns,
    renderers: deriveRenderers(visibleColumns),
    actions: {
      selectRow: () => {},
      openRecord: () => {},
      saveRows: (patches) => store.saveRows(patches),
      saveFromSource: (source) => store.saveFromSource(source),
      deleteRows: (ids) => store.deleteRows(ids),
      insertBlankRows: (target, count, position) => store.insertBlankRows(target, count, position),
      duplicateRowAsDraft: (sourceRowId) => store.duplicateRowAsDraft(sourceRowId),
    },
    getColumn: (key) => (key ? reactive.columns.find((col) => col.key === key) ?? null : null),
    coerceValue: (column, value) => coerceGridFieldValue(value, column),
    validateValue: (column, value) => validateGridFieldValue(value, column)[0] ?? null,
    emptyValues: (columns = reactive.columns) =>
      Object.fromEntries(columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null])),
  };
}

/**
 * 组件绑定的响应式 store。读取走 runes 快照（getter），写入/编排走纯逻辑层方法。
 */
export const editorStore = {
  get loading(): boolean { return reactive.loading; },
  get saving(): boolean { return reactive.saving; },
  get error(): string | null { return reactive.error; },
  get saveError(): string | null { return reactive.saveError; },
  get workbook(): WorkbookMeta | null { return reactive.workbook; },
  get activeSheetId(): RecordIdString | null { return reactive.activeSheetId; },
  get sheets(): SheetMeta[] { return reactive.sheets; },
  get columns(): GridColumnDef[] { return reactive.columns; },
  get rows() { return reactive.rows; },
  get viewParams(): ViewParams { return reactive.viewParams; },
  get visibleColumns(): GridColumnDef[] {
    return visibleColumnsFrom(reactive.columns, reactive.viewParams.hiddenFields);
  },
  get tableViewAdapter(): TableViewAdapter { return tableViewAdapter(); },
  get pendingDraftCount(): number { return pendingDraftCount(); },

  loadWorkbook: (workbookId: string, sheetId?: string) => store.loadWorkbook(workbookId, sheetId),
  reloadRows: () => store.reloadRows(),
  switchSheet: (sheetId: string) => store.switchSheet(sheetId),
  renameWorkbook: (name: string) => store.renameWorkbook(name),
  renameSheet: (sheetId: string, label: string) => store.renameSheet(sheetId, label),
  setFilters: (filters: FilterClause[], filterMode?: "and" | "or") => store.setFilters(filters, filterMode),
  setSorts: (sorts: SortClause[]) => store.setSorts(sorts),
  setHiddenFields: (hiddenFields: string[]) => store.setHiddenFields(hiddenFields),
  setGroupBy: (groupBy: string | null) => store.setGroupBy(groupBy),
  saveRows: (patches: Array<{ id?: RecordIdString; values: Record<string, unknown> }>) => store.saveRows(patches),
  importCsvRows: (input: ImportCsvRowsInput) => store.importCsvRows(input),
  writeRecordPatch: (sheetId: string, recordId: RecordIdString, values: Record<string, unknown>) =>
    store.writeRecordPatch(sheetId, recordId, values),
  writeRecordProposal: (
    proposal: Parameters<typeof store.writeRecordProposal>[0],
    values: Record<string, unknown>,
  ) => store.writeRecordProposal(proposal, values),
  saveFromSource: (source: Array<Record<string, unknown>>) => store.saveFromSource(source),
  deleteRows: (ids: Array<RecordIdString | string>) => store.deleteRows(ids),
  insertBlankRows: (
    targetRowId: RecordIdString | string | null,
    count: number,
    position: "above" | "below" | "end",
  ) => store.insertBlankRows(targetRowId, count, position),
  duplicateRowAsDraft: (sourceRowId: RecordIdString | string) => store.duplicateRowAsDraft(sourceRowId),
  commitDraftEdit: (draftId: string, values: Record<string, unknown>) => store.commitDraftEdit(draftId, values),
  updateFields: (columns: GridColumnDef[]) => store.updateFields(columns),
  addField: () => store.addField(),
  removeFieldByKey: (key: string) => store.removeFieldByKey(key),
  planFieldRemoval: (key: string) => store.planFieldRemoval(key),
  confirmFieldRemoval: (token: string) => store.confirmFieldRemoval(token),
  reorderFields: (orderedKeys: string[]) => store.reorderFields(orderedKeys),
  reset: () => store.reset(),
};
