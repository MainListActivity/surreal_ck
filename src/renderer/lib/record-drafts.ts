import type { GridColumnDef, GridRow, RecordIdString } from "../../shared/rpc.types";

type DraftBuckets = Record<string, GridRow[]>;

type DraftMutation = {
  rows: GridRow[];
  draftsBySheet: DraftBuckets;
};

type DraftInsertPosition = "above" | "below" | "end";

type PersistDraftRows = (
  sheetId: string,
  patches: Array<{ values: Record<string, unknown> }>,
) => Promise<{ ok: true; rows: GridRow[] } | { ok: false; message: string }>;

type CommitValidDraftsOptions = {
  draftsBySheet: DraftBuckets;
  activeSheetId: string | null;
  rows: GridRow[];
  getColumnsForSheet: (sheetId: string) => GridColumnDef[];
  validate: (patches: Array<{ values: Record<string, unknown> }>, columns: GridColumnDef[]) => string | null;
  persist: PersistDraftRows;
};

type CommitValidDraftsResult = DraftMutation & {
  ok: boolean;
  error: string | null;
};

const DRAFT_PREFIX = "__draft:";
let draftSeq = 0;

function nextDraftId(): RecordIdString {
  draftSeq += 1;
  return `${DRAFT_PREFIX}${Date.now().toString(36)}-${draftSeq}` as RecordIdString;
}

/** 临时记录只存在于内存中，等必填字段填齐后才晋升为真实记录。 */
export function isDraftRowId(id: string | RecordIdString | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(DRAFT_PREFIX);
}

function blankValues(columns: GridColumnDef[]): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((col) => [col.key, col.fieldType === "checkbox" ? false : null]),
  );
}

function valuesForDraft(source: GridRow, columns: GridColumnDef[]): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((col) => [
      col.key,
      source.values[col.key] ?? (col.fieldType === "checkbox" ? false : null),
    ]),
  );
}

function setBucket(draftsBySheet: DraftBuckets, sheetId: string, drafts: GridRow[]): DraftBuckets {
  if (drafts.length) return { ...draftsBySheet, [sheetId]: drafts };
  if (!draftsBySheet[sheetId]) return draftsBySheet;
  const next = { ...draftsBySheet };
  delete next[sheetId];
  return next;
}

function syncBucket(sheetId: string | null, rows: GridRow[], draftsBySheet: DraftBuckets): DraftBuckets {
  if (!sheetId) return draftsBySheet;
  return setBucket(draftsBySheet, sheetId, rows.filter((row) => isDraftRowId(row.id)));
}

function rowsWithDrafts(sheetId: string | null, persistedRows: GridRow[], draftsBySheet: DraftBuckets): GridRow[] {
  if (!sheetId) return persistedRows;
  const drafts = draftsBySheet[sheetId] ?? [];
  return drafts.length ? [...persistedRows, ...drafts] : persistedRows;
}

function insert(
  sheetId: string | null,
  rows: GridRow[],
  draftsBySheet: DraftBuckets,
  columns: GridColumnDef[],
  targetRowId: RecordIdString | string | null,
  count: number,
  position: DraftInsertPosition,
): DraftMutation | null {
  if (!sheetId) return null;
  const safeCount = Math.max(1, Math.floor(count));
  const drafts: GridRow[] = Array.from({ length: safeCount }, () => ({
    id: nextDraftId(),
    values: blankValues(columns),
  }));

  if (position === "end" || !targetRowId) {
    const nextRows = [...rows, ...drafts];
    return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
  }

  const idx = rows.findIndex((row) => row.id === targetRowId);
  if (idx === -1) {
    const nextRows = [...rows, ...drafts];
    return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
  }

  const nextRows = rows.slice();
  nextRows.splice(position === "above" ? idx : idx + 1, 0, ...drafts);
  return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
}

function duplicate(
  sheetId: string | null,
  rows: GridRow[],
  draftsBySheet: DraftBuckets,
  columns: GridColumnDef[],
  sourceRowId: RecordIdString | string,
): DraftMutation | null {
  if (!sheetId) return null;
  const idx = rows.findIndex((row) => row.id === sourceRowId);
  if (idx === -1) return null;

  const draft: GridRow = { id: nextDraftId(), values: valuesForDraft(rows[idx], columns) };
  const nextRows = rows.slice();
  nextRows.splice(idx + 1, 0, draft);
  return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
}

function discardIds(
  sheetId: string | null,
  rows: GridRow[],
  draftsBySheet: DraftBuckets,
  ids: Array<string | RecordIdString>,
): DraftMutation {
  const removed = new Set(ids);
  const nextRows = rows.filter((row) => !removed.has(row.id));
  return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
}

function merge(
  sheetId: string | null,
  rows: GridRow[],
  draftsBySheet: DraftBuckets,
  draftId: string,
  values: Record<string, unknown>,
): DraftMutation | null {
  if (!sheetId) return null;
  const idx = rows.findIndex((row) => row.id === draftId);
  if (idx === -1) return null;
  const nextRows = rows.slice();
  nextRows[idx] = { ...nextRows[idx], values: { ...values } };
  return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
}

function promote(
  sheetId: string | null,
  rows: GridRow[],
  draftsBySheet: DraftBuckets,
  draftId: string,
  promoted: GridRow,
): DraftMutation {
  const nextRows = rows.slice();
  const idx = nextRows.findIndex((row) => row.id === draftId);
  if (idx !== -1) nextRows[idx] = promoted;
  return { rows: nextRows, draftsBySheet: syncBucket(sheetId, nextRows, draftsBySheet) };
}

async function commitValid(options: CommitValidDraftsOptions): Promise<CommitValidDraftsResult> {
  let rows = options.rows;
  let draftsBySheet = options.draftsBySheet;
  let ok = true;
  let error: string | null = null;

  for (const [sheetId, drafts] of Object.entries(options.draftsBySheet)) {
    const columns = options.getColumnsForSheet(sheetId);
    if (!columns.length) continue;

    const validDrafts: Array<{ draftId: string; values: Record<string, unknown> }> = [];
    for (const draft of drafts) {
      if (!isDraftRowId(draft.id)) continue;
      const patch = [{ values: { ...draft.values } }];
      if (options.validate(patch, columns)) continue;
      validDrafts.push({ draftId: draft.id, values: patch[0].values });
    }

    if (!validDrafts.length) continue;

    const result = await options.persist(sheetId, validDrafts.map((draft) => ({ values: draft.values })));
    if (!result.ok) {
      ok = false;
      error = result.message;
      continue;
    }

    const promotedByDraftId = new Map(
      validDrafts.map((draft, index) => [draft.draftId, result.rows[index]]),
    );

    if (sheetId === options.activeSheetId) {
      rows = rows.map((row) => promotedByDraftId.get(row.id) ?? row);
    }

    draftsBySheet = setBucket(
      draftsBySheet,
      sheetId,
      drafts.filter((draft) => !promotedByDraftId.has(draft.id)),
    );
  }

  return { ok, error, rows, draftsBySheet };
}

function discardAll(rows: GridRow[]): DraftMutation {
  return {
    rows: rows.filter((row) => !isDraftRowId(row.id)),
    draftsBySheet: {},
  };
}

function count(draftsBySheet: DraftBuckets): number {
  return Object.values(draftsBySheet).reduce((sum, list) => sum + list.length, 0);
}

function diffSource(
  source: Array<Record<string, unknown>>,
  rows: GridRow[],
  columns: GridColumnDef[],
): {
  persistedPatches: Array<{ id: RecordIdString; values: Record<string, unknown> }>;
  draftEdits: Array<{ draftId: string; values: Record<string, unknown> }>;
} {
  const colKeys = columns.map((column) => column.key);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const persistedPatches: Array<{ id: RecordIdString; values: Record<string, unknown> }> = [];
  const draftEdits: Array<{ draftId: string; values: Record<string, unknown> }> = [];

  for (const raw of source) {
    const rawId = typeof raw._id === "string" ? raw._id : undefined;
    if (!rawId) continue;
    const existing = byId.get(rawId);
    if (!existing) continue;

    const values: Record<string, unknown> = {};
    for (const key of colKeys) values[key] = key in raw ? raw[key] : existing.values[key];

    if (!colKeys.some((key) => !shallowEqual(values[key], existing.values[key]))) continue;

    if (isDraftRowId(rawId)) {
      draftEdits.push({ draftId: rawId, values });
    } else {
      persistedPatches.push({ id: existing.id, values });
    }
  }

  return { persistedPatches, draftEdits };
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

export const recordDrafts = {
  syncBucket,
  rowsWithDrafts,
  insert,
  duplicate,
  discardIds,
  merge,
  promote,
  commitValid,
  discardAll,
  count,
  diffSource,
};
