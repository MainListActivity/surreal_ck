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
import { useEffect, useReducer, useCallback, useRef } from 'react';
import { Table, type Surreal } from 'surrealdb';

import { RecordId } from 'surrealdb';

import { nowDateTime, toRecordId } from '../../lib/surreal/record-id';

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
          String(s.id) === action.sheetId ? { ...s, label: action.label } : s,
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
    isLoading: workbookId !== null,
    error: null,
  });

  // Tracks the next available position synchronously to avoid duplicates
  // when createSheet is called multiple times before state updates settle.
  const nextPositionRef = useRef(0);

  // ── Load sheets ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!workbookId) return;
    let cancelled = false;

    dispatch({ type: 'load-start' });

    (async () => {
      try {
        const [sheetRows] = await db.query<[Sheet[]]>(
          `SELECT * FROM sheet WHERE workbook = $wb ORDER BY position ASC`,
          { wb: toRecordId(workbookId) },
        );
        if (cancelled) return;

        const sheets = sheetRows ?? [];

        // Validation guard: drop records missing required fields
        const validSheets = sheets.filter(
          (s): s is Sheet =>
            typeof s.univer_id === 'string' && s.univer_id.length > 0 &&
            typeof s.table_name === 'string' && s.table_name.length > 0,
        );
        if (validSheets.length !== sheets.length) {
          console.warn(
            `[use-sheets] ${sheets.length - validSheets.length} sheet(s) dropped due to missing fields`,
          );
        }

        nextPositionRef.current = validSheets.length;
        dispatch({ type: 'load-ok', sheets: validSheets });
      } catch (err) {
        if (!cancelled) {
          dispatch({
            type: 'load-err',
            error: err instanceof Error ? err.message : 'Failed to load sheets.',
          });
        }
      }
    })();

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
      const sheetPosition = position ?? nextPositionRef.current++;

      // 1. Insert the sheet record
      const workbookRecordId = toRecordId(workbookId);
      const insertedSheet = await db.insert<Sheet>(new Table('sheet'), {
        workbook: new RecordId<'workbook'>('workbook', workbookRecordId.id),
        univer_id: newUniverId,
        table_name: tableName,
        label,
        position: sheetPosition,
        column_defs: [],
      });
      const sheet = Array.isArray(insertedSheet) ? insertedSheet[0] : insertedSheet;
      if (!sheet) throw new Error('Sheet INSERT returned no record.');

      const sheetRecord: Sheet = sheet;

      // 2. Provision the backing SCHEMALESS entity table (no fields yet)
      const ddl = entityTableDDL(tableName, []);
      await db.query(ddl);

      dispatch({ type: 'append', sheet: sheetRecord });
      return sheetRecord;
    },
    // nextPositionRef is a stable ref — not a dep. state.sheets.length removed (F10).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workbookId, wsKey],
  );

  // ── Rename sheet ──────────────────────────────────────────────────────────
  const renameSheet = useCallback(
    async (sheetId: string, newLabel: string): Promise<void> => {
      await db.update<Sheet>(toRecordId(sheetId)).merge({
        label: newLabel,
        updated_at: nowDateTime(),
      });
      dispatch({ type: 'update', sheetId, label: newLabel });
    },
    [db],
  );

  return { sheets: state.sheets, isLoading: state.isLoading, error: state.error, createSheet, renameSheet };
}
