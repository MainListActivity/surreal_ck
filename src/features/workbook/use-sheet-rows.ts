/**
 * Hook for reading and writing rows in a single sheet's entity table.
 *
 * Cell value changes go directly to the SurrealDB entity table — NOT through
 * the collab mutation log. The collab log only captures layout/formula changes.
 *
 * Real-time sync: rows arrive via LIVE SELECT so all connected clients
 * see the same data without polling.
 */
import { useCallback, useEffect, useReducer } from 'react';
import type { LiveSubscription, Surreal } from 'surrealdb';
import { Table } from 'surrealdb';

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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSheetRowsResult {
  rows: EntityRow[];
  isLoading: boolean;
  error: string | null;
  /**
   * Upsert a row. If rowId is null, a new row is INSERTed.
   * fields must NOT include id, workspace, created_at, updated_at — those are
   * managed by the schema.
   */
  upsertRow: (rowId: string | null, fields: Record<string, unknown>) => Promise<string>;
  deleteRow: (rowId: string) => Promise<void>;
}

export function useSheetRows(
  db: Surreal,
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

    // Use a shared mutable object so the cleanup closure can safely access
    // values that are assigned inside the async load() function.
    const cleanupRef = {
      unsubscribe: null as (() => void) | null,
      liveQuery: null as LiveSubscription | null,
    };

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
        const [rows] = await db.query<[Array<Record<string, unknown>>]>(
          `SELECT * FROM type::table($tbl) ORDER BY created_at ASC`,
          { tbl: tableName },
        );
        if (cancelled) return;
        dispatch({ type: 'load-ok', rows: (rows ?? []).map(normalise) });

        // Subscribe to live changes
        cleanupRef.liveQuery = await db.live(new Table(tableName));
        cleanupRef.unsubscribe = cleanupRef.liveQuery.subscribe((message) => {
          const row = normalise(message.value as Record<string, unknown>);
          switch (message.action) {
            case 'CREATE':
              dispatch({ type: 'live-create', row });
              break;
            case 'UPDATE':
              dispatch({ type: 'live-update', row });
              break;
            case 'DELETE':
              dispatch({ type: 'live-delete', id: row.id });
              break;
          }
        });
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

    return () => {
      cancelled = true;
      cleanupRef.unsubscribe?.();
      void cleanupRef.liveQuery?.kill().catch(() => undefined);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, workspaceId]);

  // ── Upsert row ────────────────────────────────────────────────────────────
  const upsertRow = useCallback(
    async (rowId: string | null, fields: Record<string, unknown>): Promise<string> => {
      if (!tableName || !workspaceId) throw new Error('tableName and workspaceId required.');

      if (rowId) {
        // UPDATE existing row — merge fields, bump updated_at
        await db.query(
          `UPDATE $id MERGE $fields SET updated_at = time::now()`,
          { id: rowId, fields },
        );
        return rowId;
      }

      // INSERT new row — attach workspace for permission enforcement
      const [created] = await db.query<[Array<{ id: unknown }>]>(
        `INSERT INTO type::table($tbl) $fields RETURN id`,
        {
          tbl: tableName,
          fields: { ...fields, workspace: workspaceId },
        },
      );
      const newId = String(created?.[0]?.id ?? '');
      if (!newId) throw new Error('Row INSERT returned no id.');
      return newId;
    },
    [db, tableName, workspaceId],
  );

  // ── Delete row ────────────────────────────────────────────────────────────
  const deleteRow = useCallback(
    async (rowId: string): Promise<void> => {
      await db.query(`DELETE $id`, { id: rowId });
    },
    [db],
  );

  return { rows: state.rows, isLoading: state.isLoading, error: state.error, upsertRow, deleteRow };
}
