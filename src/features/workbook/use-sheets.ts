/**
 * Hook for loading and managing Sheet records that belong to a workbook.
 *
 * local-first 版本：通过 IPC (DbAdapter) 执行 SurrealDB 操作，
 * DDL 操作（DEFINE TABLE）由 Bun 主进程负责，不再需要 DDL proxy。
 */
import { useEffect, useReducer, useCallback, useRef } from 'react';
import type { DbAdapter } from '../../lib/surreal/db-adapter';
import { nowDateTime, toRecordId } from '../../lib/surreal/record-id';
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
  label: string;
  univerId?: string;
  position?: number;
}

export function useSheets(
  db: DbAdapter,
  workbookId: string | null,
  wsKey: string | null,
): UseSheetsResult {
  const [state, dispatch] = useReducer(reducer, {
    sheets: [],
    isLoading: workbookId !== null,
    error: null,
  });

  const nextPositionRef = useRef(0);
  const sheetsRef = useRef<Sheet[]>([]);
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
        const sheetRows = await db.query<Sheet[]>(
          `SELECT * FROM sheet WHERE workbook = $wb ORDER BY position ASC`,
          { wb: toRecordId(workbookId) },
        );
        if (cancelled) return;

        const sheets = Array.isArray(sheetRows) ? sheetRows : [];

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId]);

  // ── Create sheet ──────────────────────────────────────────────────────────
  const createSheet = useCallback(
    async ({ label, univerId, position }: CreateSheetOpts): Promise<Sheet> => {
      if (!workbookId || !wsKey) {
        throw new Error('workbookId and wsKey are required to create a sheet.');
      }

      const newUniverId = univerId ?? crypto.randomUUID();
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const tableName = `ent_${wsKey}_${suffix}`;
      const sheetPosition = position ?? nextPositionRef.current++;

      // INSERT ... ON DUPLICATE KEY UPDATE 保证 univer_id 唯一索引冲突时幂等
      const rows = await db.query<Sheet[]>(
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
          workbook:   toRecordId(workbookId),
          univer_id:  newUniverId,
          table_name: tableName,
          label,
          position:   sheetPosition,
        },
      );

      const sheet = Array.isArray(rows) ? rows[0] : rows;
      if (!sheet) throw new Error('Sheet INSERT returned no record.');

      const sheetRecord: Sheet = sheet as Sheet;
      dispatch({ type: 'append', sheet: sheetRecord });
      return sheetRecord;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workbookId, wsKey],
  );

  // ── Rename sheet ──────────────────────────────────────────────────────────
  const renameSheet = useCallback(
    async (sheetId: string, newLabel: string): Promise<void> => {
      await db.merge(sheetId, {
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

      await db.merge(String(existingSheet.id), {
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
