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
  /** 按 sheetId 分桶的 draft 行：切 sheet 时仍保留，离开工作簿（reset / 换 wb）时整体丢弃。 */
  draftsBySheet: Record<string, GridRow[]>;
};

const EMPTY_VIEW_PARAMS: ViewParams = {
  filters: [],
  filterMode: "and",
  sorts: [],
  hiddenFields: [],
  groupBy: null,
};

const DRAFT_PREFIX = "__draft:";
let draftSeq = 0;
function nextDraftId(): string {
  draftSeq += 1;
  return `${DRAFT_PREFIX}${Date.now().toString(36)}-${draftSeq}`;
}

/** 临时行（draft）只存在于内存中，未持久化到数据库；等所有必填字段填齐才会晋升为真实行。 */
export function isDraftRowId(id: string | RecordIdString | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(DRAFT_PREFIX);
}

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
    draftsBySheet: {},
  });

  /** 把 state.rows 中持久化部分写回（不动 drafts），用于在持久化操作后保持 rows 一致。 */
  function syncDraftBucket() {
    const sheetId = state.activeSheetId;
    if (!sheetId) return;
    const drafts = state.rows.filter((r) => isDraftRowId(r.id));
    if (drafts.length) {
      state.draftsBySheet = { ...state.draftsBySheet, [sheetId]: drafts };
    } else if (state.draftsBySheet[sheetId]) {
      const next = { ...state.draftsBySheet };
      delete next[sheetId];
      state.draftsBySheet = next;
    }
  }

  /** 取出指定 sheet 的 drafts（不再存于 bucket 内的副本，使用前请考虑去重）。 */
  function getDraftsForSheet(sheetId: string | null): GridRow[] {
    if (!sheetId) return [];
    return state.draftsBySheet[sheetId] ?? [];
  }

  function getColumnsForSheet(sheetId: string): GridColumnDef[] {
    if (sheetId === state.activeSheetId) return state.columns;
    return state.data?.sheets.find((sheet) => sheet.id === sheetId)?.columnDefs ?? state.columns;
  }

  async function loadWorkbook(workbookId: string, sheetId?: string) {
    state.loading = true;
    state.error = null;
    // 切到不同工作簿时整体丢弃 drafts；同 wb 内只是切 sheet/reload 由调用方决定
    const switchingWorkbook = state.data?.workbook.id !== workbookId;
    if (switchingWorkbook) {
      state.draftsBySheet = {};
    }
    state.data = null;
    try {
      const res = await appApi.getWorkbookData(workbookId, sheetId, state.viewParams);
      if (res.ok) {
        state.data = res.data;
        state.activeSheetId = res.data.activeSheetId;
        state.columns = res.data.columns;
        const drafts = getDraftsForSheet(res.data.activeSheetId);
        state.rows = drafts.length ? [...res.data.rows, ...drafts] : res.data.rows;
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
    syncDraftBucket(); // 确保当前 sheet 的 drafts 已落入 bucket
    state.loading = true;
    state.error = null;
    try {
      const res = await appApi.getWorkbookData(state.data.workbook.id, state.activeSheetId, state.viewParams);
      if (res.ok) {
        const drafts = getDraftsForSheet(state.activeSheetId);
        state.rows = drafts.length ? [...res.data.rows, ...drafts] : res.data.rows;
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
    syncDraftBucket(); // 把当前 sheet 的 drafts 留在它自己的桶里
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

  /**
   * 写入持久化行（更新已存在的真实行 / 新建持久化行）。
   * 不接受 draft id；draft 的晋升走 promoteDraftIfReady。
   */
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
        const upsertedMap = new Map(res.data.upserted.map((r) => [r.id, r]));
        const merged = state.rows.map((r) => upsertedMap.get(r.id) ?? r);
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

  /** 删除行：draft 直接本地丢弃，持久化行走 deleteRows RPC。 */
  async function deleteRowIds(ids: Array<RecordIdString | string>): Promise<boolean> {
    if (!state.activeSheetId || !ids.length) return false;
    const drafts = ids.filter((id) => isDraftRowId(id));
    const persisted = ids.filter((id) => !isDraftRowId(id)) as RecordIdString[];

    if (drafts.length) {
      const removed = new Set(drafts);
      state.rows = state.rows.filter((row) => !removed.has(row.id));
      syncDraftBucket();
    }

    if (!persisted.length) return true;

    state.saving = true;
    state.saveError = null;
    try {
      const res = await appApi.deleteRows(state.activeSheetId, persisted);
      if (res.ok) {
        const removed = new Set(persisted);
        state.rows = state.rows.filter((row) => !removed.has(row.id));
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

  function buildBlankValues(): Record<string, unknown> {
    return Object.fromEntries(
      state.columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]),
    );
  }

  /**
   * 在指定行上方/下方插入 N 行临时（draft）记录。
   * 这些行只存内存，不写库；用户编辑过程中若所有必填字段填齐，会自动晋升为真实行。
   */
  function insertBlankRows(
    targetRowId: RecordIdString | string | null,
    count: number,
    position: "above" | "below" | "end",
  ): boolean {
    if (!state.activeSheetId) return false;
    const safeCount = Math.max(1, Math.floor(count));
    const drafts: GridRow[] = Array.from({ length: safeCount }, () => ({
      id: nextDraftId() as RecordIdString,
      values: buildBlankValues(),
    }));

    if (position === "end" || !targetRowId) {
      state.rows = [...state.rows, ...drafts];
      syncDraftBucket();
      return true;
    }

    const idx = state.rows.findIndex((r) => r.id === targetRowId);
    if (idx === -1) {
      state.rows = [...state.rows, ...drafts];
      syncDraftBucket();
      return true;
    }
    const insertAt = position === "above" ? idx : idx + 1;
    const next = state.rows.slice();
    next.splice(insertAt, 0, ...drafts);
    state.rows = next;
    syncDraftBucket();
    return true;
  }

  /** 复制源行（持久化或 draft）为一个新的 draft，插入到源行下方。不直接写库。 */
  function duplicateRowAsDraft(sourceRowId: RecordIdString | string): boolean {
    if (!state.activeSheetId) return false;
    const idx = state.rows.findIndex((r) => r.id === sourceRowId);
    if (idx === -1) return false;
    const source = state.rows[idx];
    const values = Object.fromEntries(
      state.columns.map((col) => [
        col.key,
        source.values[col.key] ?? (col.fieldType === "checkbox" ? false : null),
      ]),
    );
    const draft: GridRow = { id: nextDraftId() as RecordIdString, values };
    const next = state.rows.slice();
    next.splice(idx + 1, 0, draft);
    state.rows = next;
    syncDraftBucket();
    return true;
  }

  /**
   * 把 draft 行合并新值并尝试晋升为持久化行：
   * - 必填校验通过 → 调 upsertRows，写库后用真实 id 替换 draft id
   * - 校验未通过 → 仅更新内存 draft.values，保持为 draft
   * 返回值仅表示「是否晋升成功」。校验失败不算错误。
   */
  async function commitDraftEdit(
    draftId: string,
    values: Record<string, unknown>,
  ): Promise<{ promoted: boolean; newId?: RecordIdString }> {
    if (!state.activeSheetId) return { promoted: false };
    const idx = state.rows.findIndex((r) => r.id === draftId);
    if (idx === -1) return { promoted: false };

    // 先更新内存 draft（无论是否能晋升，编辑结果都要保留在 UI 上）
    const next = state.rows.slice();
    next[idx] = { ...next[idx], values: { ...values } };
    state.rows = next;
    syncDraftBucket();

    const probe = [{ values: { ...values } }];
    const validationError = validatePatches(probe, state.columns);
    if (validationError) {
      // 留作 draft，UI 不弹错——这正是 draft 设计的目的
      return { promoted: false };
    }

    state.saving = true;
    state.saveError = null;
    try {
      const res = await appApi.upsertRows(state.activeSheetId, probe);
      if (!res.ok) {
        state.saveError = res.message;
        return { promoted: false };
      }
      const promoted = res.data.upserted[0];
      if (!promoted) return { promoted: false };
      const after = state.rows.slice();
      const at = after.findIndex((r) => r.id === draftId);
      if (at !== -1) after[at] = promoted;
      state.rows = after;
      syncDraftBucket();
      return { promoted: true, newId: promoted.id };
    } catch (err) {
      state.saveError = String(err);
      return { promoted: false };
    } finally {
      state.saving = false;
    }
  }

  /**
   * 离开工作簿前扫描所有 draft：能通过完整校验的先按 sheet 批量写库，
   * 不完整的继续留作 draft，随后由 discardAllDrafts 丢弃。
   */
  async function commitValidDrafts(): Promise<boolean> {
    const sheetEntries = Object.entries(state.draftsBySheet);
    if (!sheetEntries.length || !state.columns.length) return true;

    let ok = true;
    state.saving = true;
    state.saveError = null;
    try {
      for (const [sheetId, drafts] of sheetEntries) {
        const columns = getColumnsForSheet(sheetId);
        if (!columns.length) continue;

        const validDrafts: Array<{ draftId: string; values: Record<string, unknown> }> = [];

        for (const draft of drafts) {
          if (!isDraftRowId(draft.id)) continue;
          const patch = [{ values: { ...draft.values } }];
          if (validatePatches(patch, columns)) continue;
          validDrafts.push({ draftId: draft.id, values: patch[0].values });
        }

        if (!validDrafts.length) continue;

        const res = await appApi.upsertRows(sheetId, validDrafts.map((draft) => ({ values: draft.values })));
        if (!res.ok) {
          state.saveError = res.message;
          ok = false;
          continue;
        }

        const promotedByDraftId = new Map(
          validDrafts.map((draft, index) => [draft.draftId, res.data.upserted[index]]),
        );

        if (sheetId === state.activeSheetId) {
          state.rows = state.rows.map((row) => promotedByDraftId.get(row.id) ?? row);
        }

        const remainingDrafts = drafts.filter((draft) => !promotedByDraftId.has(draft.id));
        if (remainingDrafts.length) {
          state.draftsBySheet = { ...state.draftsBySheet, [sheetId]: remainingDrafts };
        } else {
          const next = { ...state.draftsBySheet };
          delete next[sheetId];
          state.draftsBySheet = next;
        }
      }
      return ok;
    } catch (err) {
      state.saveError = String(err);
      return false;
    } finally {
      state.saving = false;
    }
  }

  /**
   * 接收 RevoGrid 全量 source（含 draft + persisted），diff 出真正变更的行并分流：
   * - persisted 变更 → upsertRows
   * - draft 变更 → commitDraftEdit（达标晋升 / 否则只更新内存）
   *
   * 返回值仅表示「是否有持久化错误（持久化行写库失败 / 数据校验失败）」；
   * draft 校验未通过不视为失败。
   */
  async function saveFromSource(source: Array<Record<string, unknown>>): Promise<boolean> {
    if (!state.activeSheetId || !state.columns.length) return false;
    const colKeys = state.columns.map((c) => c.key);
    const byId = new Map(state.rows.map((row) => [row.id, row]));

    const persistedPatches: Array<{ id: RecordIdString; values: Record<string, unknown> }> = [];
    const draftEdits: Array<{ draftId: string; values: Record<string, unknown> }> = [];

    for (const raw of source) {
      const rawId = typeof raw._id === "string" ? raw._id : undefined;
      if (!rawId) continue;
      const existing = byId.get(rawId);
      if (!existing) continue;

      const values: Record<string, unknown> = {};
      for (const k of colKeys) values[k] = k in raw ? raw[k] : existing.values[k];

      // diff：只处理真正发生变化的行
      const changed = colKeys.some((k) => !shallowEqual(values[k], existing.values[k]));
      if (!changed) continue;

      if (isDraftRowId(rawId)) {
        draftEdits.push({ draftId: rawId, values });
      } else {
        persistedPatches.push({ id: existing.id, values });
      }
    }

    let ok = true;
    if (persistedPatches.length) {
      const success = await saveRows(persistedPatches);
      if (!success) ok = false;
    }
    for (const edit of draftEdits) {
      await commitDraftEdit(edit.draftId, edit.values);
    }
    return ok;
  }

  function reset() {
    state.data = null;
    state.activeSheetId = null;
    state.columns = [];
    state.rows = [];
    state.error = null;
    state.saveError = null;
    state.viewParams = { ...EMPTY_VIEW_PARAMS };
    state.draftsBySheet = {};
  }

  function discardAllDrafts() {
    state.draftsBySheet = {};
    state.rows = state.rows.filter((r) => !isDraftRowId(r.id));
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
    set rows(v) { state.rows = v; },
    get sheets(): SheetSummaryDTO[] { return state.data?.sheets ?? []; },
    get workbookName(): string { return state.data?.workbook.name ?? ""; },
    get viewParams(): ViewParams { return state.viewParams; },
    /** 隐藏字段过滤后的可见列；视图组件统一消费此入口 */
    get visibleColumns(): GridColumnDef[] {
      const hidden = new Set(state.viewParams.hiddenFields ?? []);
      return state.columns.filter((col) => !hidden.has(col.key));
    },
    /** 整个工作簿内（所有 sheet）尚未持久化的草稿行数。 */
    get pendingDraftCount(): number {
      return Object.values(state.draftsBySheet).reduce((sum, list) => sum + list.length, 0);
    },
    loadWorkbook,
    reloadRows,
    switchSheet,
    saveRows,
    deleteRowIds,
    insertBlankRows,
    duplicateRowAsDraft,
    commitDraftEdit,
    commitValidDrafts,
    saveFromSource,
    renameWorkbook,
    updateFields,
    setFilters,
    setSorts,
    setHiddenFields,
    setGroupBy,
    reset,
    discardAllDrafts,
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

/** 浅比较：处理 null/undefined/原始值；Date 比 getTime；其它对象按 JSON。 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
