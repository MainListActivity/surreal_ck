import { useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';

export interface WorkbookSummaryDb {
  id: string;
  name: string;
  template_key: string | null;
  updated_at: string;
}

export interface WorkspaceDb {
  id: string;
  name: string;
  memberCount: number;
  workbooks: WorkbookSummaryDb[];
}

interface State {
  data: WorkspaceDb | null;
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; data: WorkspaceDb }
  | { type: 'load-err'; error: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { data: action.data, isLoading: false, error: null };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    default:
      return state;
  }
}

/**
 * Loads the workspace the current user owns, plus all workbooks linked to it.
 * Falls back to null while loading or on error.
 */
export function useWorkspace(db: Surreal): State {
  const [state, dispatch] = useReducer(reducer, { data: null, isLoading: false, error: null });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      dispatch({ type: 'load-start' });
      try {
        // Schema PERMISSIONS enforce visibility — SELECT FROM workspace returns only what
        // the authenticated user is allowed to see. No client-side auth filtering needed.
        const results = await db.query<
          [Array<{ id: string; name: string; memberCount: number }>, WorkbookSummaryDb[]]
        >(
          `
          SELECT
            id,
            name,
            count(<-workspace_has_member) AS memberCount
          FROM workspace
          LIMIT 1;

          SELECT
            out.id           AS id,
            out.name         AS name,
            out.template_key AS template_key,
            out.updated_at   AS updated_at,
            out.created_at   AS created_at
          FROM workspace_has_workbook
          ORDER BY created_at ASC;
          `,
        );

        if (cancelled) return;

        const workspaceRows = results[0];
        const workbookRows = results[1];
        const ws = Array.isArray(workspaceRows) ? workspaceRows[0] : undefined;
        if (!ws) {
          dispatch({ type: 'load-err', error: 'No workspace found for this account.' });
          return;
        }

        dispatch({
          type: 'load-ok',
          data: {
            id: String(ws.id),
            name: ws.name,
            memberCount: ws.memberCount ?? 0,
            workbooks: Array.isArray(workbookRows) ? workbookRows : [],
          },
        });
      } catch (err) {
        if (!cancelled) {
          dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load workspace.' });
        }
      }
    }

    void load();
    return () => { cancelled = true; };
  // db identity is stable (module-level singleton); no need to re-run on db reference change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

/**
 * Loads a single workbook row list from SurrealDB.
 * Queries the dynamic entity table inferred from template_key.
 */
export interface EntityRow {
  id: string;
  name: string;
  jurisdiction: string | null;
  status: string | null;
}

export function templateToEntityTable(templateKey: string | null): string | null {
  if (templateKey === 'legal-entity-tracker') return 'company';
  if (templateKey === 'case-management') return 'case';
  return null;
}

export function formatUpdatedAt(isoString: string | undefined | null): string {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}
