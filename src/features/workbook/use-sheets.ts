/**
 * Hook for loading and managing Sheet records that belong to a workbook.
 *
 * Each Sheet corresponds to one SurrealDB SCHEMALESS entity table:
 *   table_name = "ent_{ws_key}_{random_suffix}"
 *
 * Creating a sheet also runs entityTableDDL() to provision the backing table
 * with workspace-scoped permissions. No column definitions are required unless
 * the user later adds typed fields or relations.
 */
import { useEffect, useReducer, useCallback } from 'react';
import type { Surreal } from 'surrealdb';

import { entityTableDDL } from '../../lib/surreal/ddl';
import type { Sheet } from '../../lib/surreal/types';

export type { Sheet as SheetRecord };

// ─── State machine ────────────────────────────────────────────────────────────

interface State {
  sheets: Sheet[];
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; sheets: Sheet[] }
  | { type: 'load-err'; error: string }
  | { type: 'append'; sheet: Sheet }
  | { type: 'update'; sheetId: string; label: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { sheets: action.sheets, isLoading: false, error: null };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'append':
      return { ...state, sheets: [...state.sheets, action.sheet] };
    case 'update':
      return {
        ...state,
        sheets: state.sheets.map((s) =>
          s.id === action.sheetId ? { ...s, label: action.label } : s,
        ),
      };
    default:
      return state;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSheetsResult {
  sheets: Sheet[];
  isLoading: boolean;
  error: string | null;
  createSheet: (opts: CreateSheetOpts) => Promise<Sheet>;
  renameSheet: (sheetId: string, newLabel: string) => Promise<void>;
}

export interface CreateSheetOpts {
  /** Human-visible tab name, e.g. "Companies". */
  label: string;
  /**
   * Univer subUnitId for this sheet. Pass the ID that Univer already assigned
   * (e.g. from an `onSheetAdded` callback) so the binding stays stable.
   * If omitted, a new UUID is generated.
   */
  univerId?: string;
  /** Position (tab order). Defaults to sheets.length. */
  position?: number;
}

export function useSheets(
  db: Surreal,
  workbookId: string | null,
  wsKey: string | null,
): UseSheetsResult {
  const [state, dispatch] = useReducer(reducer, {
    sheets: [],
    isLoading: false,
    error: null,
  });

  // ── Load sheets ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!workbookId) return;
    let cancelled = false;

    dispatch({ type: 'load-start' });

    db.query<[Sheet[]]>(
      `SELECT * FROM workbook_has_sheet WHERE in = $wb FETCH out`,
      { wb: workbookId },
    )
      .then(([rows]) => {
        if (cancelled) return;
        // The FETCH out returns nested objects — extract the `out` field.
        const sheets = (rows ?? []).map((row) => {
          const out = (row as unknown as { out: Sheet }).out;
          return { ...out, id: String(out.id), workbook: String(out.workbook) };
        });
        dispatch({ type: 'load-ok', sheets });
      })
      .catch((err) => {
        if (!cancelled) {
          dispatch({
            type: 'load-err',
            error: err instanceof Error ? err.message : 'Failed to load sheets.',
          });
        }
      });

    return () => { cancelled = true; };
  // db is a stable singleton; workbookId changes on workbook switch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId]);

  // ── Create sheet ──────────────────────────────────────────────────────────
  const createSheet = useCallback(
    async ({ label, univerId, position }: CreateSheetOpts): Promise<Sheet> => {
      if (!workbookId || !wsKey) {
        throw new Error('workbookId and wsKey are required to create a sheet.');
      }

      // Generate stable identifiers
      const newUniverId = univerId ?? crypto.randomUUID();
      // 8-char suffix: lowercase hex from random UUID, no hyphens
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const tableName = `ent_${wsKey}_${suffix}`;
      const sheetPosition = position ?? state.sheets.length;

      // 1. Insert the sheet record
      const [created] = await db.query<[Sheet[]]>(
        `INSERT INTO sheet {
           workbook:    $wb,
           univer_id:   $uid,
           table_name:  $tbl,
           label:       $label,
           position:    $pos,
           column_defs: []
         } RETURN AFTER`,
        {
          wb: workbookId,
          uid: newUniverId,
          tbl: tableName,
          label,
          pos: sheetPosition,
        },
      );
      const sheet = created?.[0];
      if (!sheet) throw new Error('Sheet INSERT returned no record.');

      const sheetRecord: Sheet = {
        ...sheet,
        id: String(sheet.id),
        workbook: String(sheet.workbook),
      };

      // 2. Link sheet to workbook via edge
      await db.query(
        `INSERT INTO workbook_has_sheet { in: $wb, out: $sheet }`,
        { wb: workbookId, sheet: sheetRecord.id },
      );

      // 3. Provision the backing SCHEMALESS entity table (no fields yet)
      const ddl = entityTableDDL(tableName, []);
      await db.query(ddl);

      dispatch({ type: 'append', sheet: sheetRecord });
      return sheetRecord;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workbookId, wsKey, state.sheets.length],
  );

  // ── Rename sheet ──────────────────────────────────────────────────────────
  const renameSheet = useCallback(
    async (sheetId: string, newLabel: string): Promise<void> => {
      await db.query(
        `UPDATE $id SET label = $label, updated_at = time::now()`,
        { id: sheetId, label: newLabel },
      );
      dispatch({ type: 'update', sheetId, label: newLabel });
    },
    [db],
  );

  return { sheets: state.sheets, isLoading: state.isLoading, error: state.error, createSheet, renameSheet };
}
