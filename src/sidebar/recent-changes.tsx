import { useEffect, useReducer } from 'react';
import type { LiveMessage, LiveSubscription, Surreal } from 'surrealdb';
import { Table } from 'surrealdb';

interface MutationRecord {
  id: string;
  command_id: string;
  client_id: string;
  actor?: { name?: string; email?: string };
  created_at: string;
}

const COMMAND_LABELS: Record<string, string> = {
  'sheet.operation.set-range-values': 'Edited cells',
  'sheet.command.insert-row': 'Inserted row',
  'sheet.command.delete-row': 'Deleted row',
  'sheet.command.insert-column': 'Inserted column',
  'sheet.command.delete-column': 'Deleted column',
  'sheet.command.merge-cells': 'Merged cells',
  'sheet.command.unmerge-cells': 'Unmerged cells',
  'sheet.command.set-border': 'Changed border',
  'sheet.command.set-style': 'Changed style',
};

function formatCommandLabel(commandId: string): string {
  return COMMAND_LABELS[commandId] ?? 'Unknown action';
}

function formatActor(record: MutationRecord): string {
  return record.actor?.name ?? record.actor?.email ?? record.client_id;
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface State {
  items: MutationRecord[];
  isLoading: boolean;
  error: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: MutationRecord[] }
  | { type: 'load-err'; error: string }
  | { type: 'prepend'; item: MutationRecord };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { ...state, isLoading: false, items: action.items };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'prepend':
      return { ...state, items: [action.item, ...state.items].slice(0, 20) };
    default:
      return state;
  }
}

export interface RecentChangesPanelProps {
  db: Surreal;
  workbookId: string;
}

export function RecentChangesPanel({ db, workbookId }: RecentChangesPanelProps) {
  const [state, dispatch] = useReducer(reducer, { items: [], isLoading: false, error: null });

  useEffect(() => {
    let liveQuery: LiveSubscription | undefined;

    async function fetchMutation(mutationId: string): Promise<MutationRecord | null> {
      const [rows] = await db.query<[MutationRecord[]]>(
        `SELECT
           id,
           command_id,
           client_id,
           created_at,
           ->mutation_actor_user->app_user[0] AS actor
         FROM $id
         LIMIT 1`,
        { id: mutationId },
      );
      return rows?.[0] ?? null;
    }

    async function init() {
      dispatch({ type: 'load-start' });
      try {
        const [rows] = await db.query<[MutationRecord[]]>(
          `SELECT
             out.id AS id,
             out.command_id AS command_id,
             out.client_id AS client_id,
             out.created_at AS created_at,
             out->mutation_actor_user->app_user[0] AS actor
           FROM workbook_has_mutation
           WHERE in = $wb
           ORDER BY out.created_at DESC
           LIMIT 20`,
          { wb: workbookId },
        );
        dispatch({ type: 'load-ok', items: rows ?? [] });

        // LIVE SELECT for real-time prepend.
        liveQuery = await db.live(new Table('workbook_has_mutation'));
        liveQuery.subscribe((message: LiveMessage) => {
          if (message.action !== 'CREATE') {
            return;
          }

          const edge = message.value as { in?: string; out?: string };
          if (edge.in !== workbookId || !edge.out) {
            return;
          }

          void fetchMutation(edge.out)
            .then((item) => {
              if (item) {
                dispatch({ type: 'prepend', item });
              }
            })
            .catch(() => undefined);
        });
      } catch (err) {
        dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load.' });
      }
    }

    void init();
    return () => {
      void liveQuery?.kill();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId]);

  return (
    <div className="sidebar-panel__content">
      <p className="eyebrow">Recent changes</p>
      <h2>Last 20 mutations</h2>

      {state.isLoading && <p className="sidebar-copy">Loading…</p>}
      {state.error && (
        <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>
          {state.error}
        </p>
      )}
      {!state.isLoading && state.items.length === 0 && (
        <p className="sidebar-copy">No recent changes yet. Edits to this workbook will appear here.</p>
      )}

      <ul className="sidebar-list sidebar-list--flush recent-changes-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="recent-change-item">
            <div>
              <strong>{formatActor(item)}</strong>
              <span className="sidebar-copy">{formatCommandLabel(item.command_id)}</span>
            </div>
            <span className="mono-label recent-change-item__time">
              {formatRelativeTime(item.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
