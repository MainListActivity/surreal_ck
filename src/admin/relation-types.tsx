import { useEffect, useReducer, useState } from 'react';
import type { Surreal } from 'surrealdb';

export interface RelationType {
  id: string;
  key: string;
  label: string;
  from_entity_type: string;
  to_entity_type: string;
}

interface State {
  items: RelationType[];
  isLoading: boolean;
  error: string | null;
  isCreating: boolean;
  createError: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: RelationType[] }
  | { type: 'load-err'; error: string }
  | { type: 'create-start' }
  | { type: 'create-ok'; item: RelationType }
  | { type: 'create-err'; error: string }
  | { type: 'delete-ok'; id: string }
  | { type: 'clear-create-error' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { ...state, isLoading: false, items: action.items };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'create-start':
      return { ...state, isCreating: true, createError: null };
    case 'create-ok':
      return { ...state, isCreating: false, items: [...state.items, action.item] };
    case 'create-err':
      return { ...state, isCreating: false, createError: action.error };
    case 'delete-ok':
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    case 'clear-create-error':
      return { ...state, createError: null };
    default:
      return state;
  }
}

export interface RelationTypesPanelProps {
  db: Surreal;
  workspaceId: string;
}

export function RelationTypesPanel({ db, workspaceId }: RelationTypesPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [], isLoading: false, error: null, isCreating: false, createError: null,
  });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ label: '', fromType: '', toType: '' });

  useEffect(() => {
    void loadRelationTypes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadRelationTypes() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[RelationType[]]>(
        `SELECT
           out.id AS id,
           out.key AS key,
           out.label AS label,
           out->relation_from_type->entity_type[0].key AS from_entity_type,
           out->relation_to_type->entity_type[0].key AS to_entity_type
         FROM workspace_has_relation_type
         WHERE in = $ws
         ORDER BY out.label`,
        { ws: workspaceId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCreate() {
    const label = form.label.trim();
    const fromType = form.fromType.trim();
    const toType = form.toType.trim();
    if (!label || !fromType || !toType) return;

    const key = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    dispatch({ type: 'create-start' });

    try {
      const [fromRows] = await db.query<[Array<{ id: string }> ]>(
        'SELECT out.id AS id FROM workspace_has_entity_type WHERE in = $ws AND out.key = $key LIMIT 1',
        { ws: workspaceId, key: fromType },
      );
      const [toRows] = await db.query<[Array<{ id: string }> ]>(
        'SELECT out.id AS id FROM workspace_has_entity_type WHERE in = $ws AND out.key = $key LIMIT 1',
        { ws: workspaceId, key: toType },
      );
      const fromEntityId = fromRows?.[0]?.id;
      const toEntityId = toRows?.[0]?.id;
      if (!fromEntityId || !toEntityId) {
        throw new Error('Both source and target entity types must exist before creating a relationship type.');
      }

      const [created] = await db.query<[RelationType[]]>(
        `LET $relation = (INSERT INTO relation_type {
           workspace: $ws,
           key: $key,
           label: $label
         } RETURN AFTER)[0];
         RELATE $ws->workspace_has_relation_type->$relation;
         RELATE $relation->relation_from_type->$fromEntity;
         RELATE $relation->relation_to_type->$toEntity;
         RETURN {
           id: $relation.id,
           key: $relation.key,
           label: $relation.label,
           from_entity_type: $fromKey,
           to_entity_type: $toKey
         };`,
        {
          ws: workspaceId,
          key,
          label,
          fromEntity: fromEntityId,
          toEntity: toEntityId,
          fromKey: fromType,
          toKey: toType,
        },
      );
      const item = created?.[0];
      if (!item) throw new Error('relation_type record not returned');

      dispatch({ type: 'create-ok', item });
      setForm({ label: '', fromType: '', toType: '' });
      setShowForm(false);
    } catch (err) {
      dispatch({ type: 'create-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleDelete(item: RelationType) {
    try {
      await db.query(
        `DELETE relation_from_type WHERE in = $id;
         DELETE relation_to_type WHERE in = $id;
         DELETE workspace_has_relation_type WHERE in = $ws AND out = $id;
         DELETE $id`,
        { id: item.id, ws: workspaceId },
      );
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // non-fatal
    }
  }

  const formValid = form.label.trim() && form.fromType.trim() && form.toType.trim();

  return (
    <section aria-label="Relationship types">
      <div className="admin-section-header">
        <h3>Relationship Types</h3>
        <button
          className="secondary-button"
          type="button"
          onClick={() => { setShowForm(true); dispatch({ type: 'clear-create-error' }); }}
        >
          Add
        </button>
      </div>

      {showForm && (
        <form
          className="admin-inline-form"
          onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
        >
          <label className="admin-form-label" htmlFor="rel-label">
            Label
            <input
              id="rel-label"
              className="admin-form-input"
              type="text"
              placeholder="e.g. Owns"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              disabled={state.isCreating}
              autoFocus
            />
          </label>
          <label className="admin-form-label" htmlFor="rel-from">
            From entity type
            <input
              id="rel-from"
              className="admin-form-input"
              type="text"
              placeholder="e.g. company"
              value={form.fromType}
              onChange={(e) => setForm((f) => ({ ...f, fromType: e.target.value }))}
              disabled={state.isCreating}
            />
          </label>
          <label className="admin-form-label" htmlFor="rel-to">
            To entity type
            <input
              id="rel-to"
              className="admin-form-input"
              type="text"
              placeholder="e.g. company"
              value={form.toType}
              onChange={(e) => setForm((f) => ({ ...f, toType: e.target.value }))}
              disabled={state.isCreating}
            />
          </label>
          {state.createError && (
            <p className="admin-form-error" role="alert">{state.createError}</p>
          )}
          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isCreating || !formValid}>
              {state.isCreating ? 'Creating…' : 'Create'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setForm({ label: '', fromType: '', toType: '' }); }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">Loading…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}
      {!state.isLoading && state.items.length === 0 && <p className="sidebar-copy">No relationship types yet.</p>}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.label}</strong>
              <span className="mono-label">{item.from_entity_type} → {item.to_entity_type}</span>
            </div>
            <button
              className="ghost-button"
              type="button"
              aria-label={`Delete ${item.label}`}
              onClick={() => void handleDelete(item)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
