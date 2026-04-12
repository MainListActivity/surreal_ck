/**
 * Hook for loading and managing Sheet records that belong to a workbook.
 *
 * Each Sheet corresponds to one SurrealDB SCHEMALESS entity table:
 *   table_name = "ent_{ws_key}_{random_suffix}"
 *
 * Creating a sheet calls the DDL proxy service to provision the backing table
 * with workspace-scoped permissions. No column definitions are required unless
 * the user later adds typed fields or relations.
 */
import { useEffect, useReducer, useCallback, useRef } from 'react';
import { type Surreal } from 'surrealdb';

import { RecordId } from 'surrealdb';

import { nowDateTime, toRecordId } from '../../lib/surreal/record-id';

import { execDdlTemplate } from '../../lib/surreal/ddl-proxy';
import { authGateway } from '../auth/auth';
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
  upsertSheetByUniverId: (opts: CreateSheetOpts) => Promise<Sheet>;
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
  const sheetsRef = useRef<Sheet[]>([]);
  // In-flight dedup: maps univerId → pending Promise<Sheet>.
  // Prevents a second queueSheetUpsert call (e.g. from Univer's immediate
  // set-worksheet-name rename after insert-sheet-mutation) from spawning a
  // second createSheet while the first is still in flight.
  const pendingUpserts = useRef(new Map<string, Promise<Sheet>>());

  useEffect(() => {
    sheetsRef.current = state.sheets;
  }, [state.sheets]);

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

      // 1. Insert the sheet record — ON DUPLICATE KEY UPDATE 保证 univer_id 唯一索引冲突时幂等
      const workbookRecordId = toRecordId(workbookId);
      const [rows] = await db.query<[Sheet[]]>(
        `INSERT INTO sheet {
          workbook:    $workbook,
          univer_id:   $univer_id,
          table_name:  $table_name,
          label:       $label,
          position:    $position,
          column_defs: []
        } ON DUPLICATE KEY UPDATE
          label      = $input.label,
          position   = $input.position,
          updated_at = time::now()`,
        {
          workbook:   new RecordId<'workbook'>('workbook', workbookRecordId.id),
          univer_id:  newUniverId,
          table_name: tableName,
          label,
          position:   sheetPosition,
        },
      );
      const sheet = rows?.[0];
      if (!sheet) throw new Error('Sheet INSERT returned no record.');

      const sheetRecord: Sheet = sheet;

      // 2. Provision the backing SCHEMALESS entity table via DDL proxy.
      // Record users cannot execute DEFINE statements; the proxy service holds
      // root-level credentials and executes the pre-approved template.
      const accessToken = await authGateway.validAccessToken();
      if (!accessToken) throw new Error('No valid access token for DDL proxy.');
      await execDdlTemplate(accessToken, 'ddl-entity-table', { table_name: tableName });

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

  const upsertSheetByUniverId = useCallback(
    async ({ label, univerId, position }: CreateSheetOpts): Promise<Sheet> => {
      const targetUniverId = univerId?.trim();
      if (!targetUniverId) {
        throw new Error('univerId is required to upsert a sheet.');
      }

      const existingSheet = sheetsRef.current.find((sheet) => sheet.univer_id === targetUniverId);
      if (!existingSheet) {
        // Check if a createSheet call for this univerId is already in flight.
        // This happens when Univer fires set-worksheet-name immediately after
        // insert-sheet-mutation — both arrive before the first createSheet resolves.
        const inflight = pendingUpserts.current.get(targetUniverId);
        if (inflight) return inflight;

        const promise = createSheet({ label, univerId: targetUniverId, position });
        pendingUpserts.current.set(targetUniverId, promise);
        promise.finally(() => pendingUpserts.current.delete(targetUniverId));
        return promise;
      }

      if (existingSheet.label === label) {
        return existingSheet;
      }

      await db.update<Sheet>(existingSheet.id).merge({
        label,
        updated_at: nowDateTime(),
      });
      dispatch({ type: 'update', sheetId: String(existingSheet.id), label });
      return { ...existingSheet, label };
    },
    [createSheet, db],
  );

  return {
    sheets: state.sheets,
    isLoading: state.isLoading,
    error: state.error,
    createSheet,
    upsertSheetByUniverId,
    renameSheet,
  };
}
