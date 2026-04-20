/**
 * Hook for reading and writing rows in a single sheet's entity table.
 *
 * local-first 版本：通过 IPC DbAdapter 订阅 CHANGEFEED 实现实时同步，
 * 替代原来的 db.live()。
 */
import { useCallback, useEffect, useReducer } from 'react';
import type { DbAdapter } from '../../lib/surreal/db-adapter';
import { toRecordId } from '../../lib/surreal/record-id';

export interface EntityRow {
  id: string;
  workspace: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

interface State {
  rows: EntityRow[];
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; rows: EntityRow[] }
  | { type: 'load-err'; error: string }
  | { type: 'live-create'; row: EntityRow }
  | { type: 'live-update'; row: EntityRow }
  | { type: 'live-delete'; id: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { rows: action.rows, isLoading: false, error: null };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'live-create':
      return { ...state, rows: [...state.rows, action.row] };
    case 'live-update':
      return {
        ...state,
        rows: state.rows.map((r) => (r.id === action.row.id ? action.row : r)),
      };
    case 'live-delete':
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id) };
    default:
      return state;
  }
}

export interface UseSheetRowsResult {
  rows: EntityRow[];
  isLoading: boolean;
  error: string | null;
  upsertRow: (rowId: string | null, rowIndex: number, fields: Record<string, unknown>) => Promise<string>;
  deleteRow: (rowId: string) => Promise<void>;
}

export function useSheetRows(
  db: DbAdapter,
  tableName: string | null,
  workspaceId: string | null,
): UseSheetRowsResult {
  const [state, dispatch] = useReducer(reducer, {
    rows: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!tableName || !workspaceId) return;

    let cancelled = false;

    const normalise = (raw: Record<string, unknown>): EntityRow => ({
      ...raw,
      id: String(raw.id),
      workspace: String(raw.workspace ?? ''),
      created_at: String(raw.created_at ?? ''),
      updated_at: String(raw.updated_at ?? ''),
    });

    const load = async () => {
      dispatch({ type: 'load-start' });
      try {
        const rows = await db.query<Array<Record<string, unknown>>>(
          `SELECT * FROM type::table($tbl) ORDER BY created_at ASC`,
          { tbl: tableName },
        );
        if (cancelled) return;
        dispatch({ type: 'load-ok', rows: (Array.isArray(rows) ? rows : []).map(normalise) });
      } catch (err) {
        if (!cancelled) {
          dispatch({
            type: 'load-err',
            error: err instanceof Error ? err.message : 'Failed to load rows.',
          });
        }
      }
    };

    void load();

    // 通过 CHANGEFEED IPC 订阅实时变更
    const unsub = db.subscribe<Record<string, unknown>>(tableName, (message) => {
      if (cancelled) return;
      if (!message.record && message.action !== 'DELETE') return;

      const row = normalise(message.record ?? { id: message.id });
      switch (message.action) {
        case 'CREATE':
          dispatch({ type: 'live-create', row });
          break;
        case 'UPDATE':
          dispatch({ type: 'live-update', row });
          break;
        case 'DELETE':
          dispatch({ type: 'live-delete', id: message.id });
          break;
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, workspaceId]);

  const upsertRow = useCallback(
    async (rowId: string | null, rowIndex: number, fields: Record<string, unknown>): Promise<string> => {
      if (!tableName || !workspaceId) throw new Error('tableName and workspaceId required.');

      if (rowId) {
        const setClause = Object.keys(fields).map((k) => `${k} = $f_${k}`).join(', ');
        const fieldParams = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`f_${k}`, v]));
        await db.query(
          `UPDATE $id SET updated_at = time::now()${setClause ? `, ${setClause}` : ''}`,
          { id: toRecordId(rowId), ...fieldParams },
        );
        return rowId;
      }

      const contentFields = { ...fields, workspace: workspaceId };
      const fieldEntries = Object.keys(contentFields).map((k) => `${k}: $f_${k}`).join(', ');
      const fieldParams = Object.fromEntries(Object.entries(contentFields).map(([k, v]) => [`f_${k}`, v]));

      const created = await db.query<Array<{ id: unknown }>>(
        `UPSERT type::thing($tbl, $row_id) CONTENT { ${fieldEntries}, updated_at: time::now() } RETURN id`,
        { tbl: tableName, row_id: rowIndex, ...fieldParams },
      );
      const newId = String((Array.isArray(created) ? created[0] : created)?.id ?? '');
      if (!newId) throw new Error('Row UPSERT returned no id.');
      return newId;
    },
    [db, tableName, workspaceId],
  );

  const deleteRow = useCallback(
    async (rowId: string): Promise<void> => {
      await db.query(`DELETE $id`, { id: toRecordId(rowId) });
    },
    [db],
  );

  return { rows: state.rows, isLoading: state.isLoading, error: state.error, upsertRow, deleteRow };
}
