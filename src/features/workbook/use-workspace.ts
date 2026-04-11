import { useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';

export interface WorkbookSummaryDb {
  id: string;
  name: string;
  template_key: string | null;
  created_at?: string | null;
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
          ORDER BY updated_at DESC, created_at DESC;
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
            // SurrealDB 2.x returns RecordId objects for id fields — coerce to string.
            workbooks: Array.isArray(workbookRows)
              ? workbookRows.map((wb) => ({ ...wb, id: String(wb.id) }))
              : [],
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

export interface EntityRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Maps a template key + workspace key to the primary entity table name.
 * Table names are derived deterministically: ent_{ws_key}_{entity_key}.
 * Returns null if the template key is unknown or ws_key is not available.
 */
export function templateToEntityTable(wsKey: string | null | undefined, templateKey: string | null | undefined): string | null {
  if (!wsKey || !templateKey) return null;
  const primaryEntity: Record<string, string> = {
    'legal-entity-tracker': 'company',
    'case-management': 'case',
  };
  const entity = primaryEntity[templateKey];
  if (!entity) return null;
  return `ent_${wsKey}_${entity}`;
}

export function formatUpdatedAt(isoString: string | undefined | null): string {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚更新';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}
