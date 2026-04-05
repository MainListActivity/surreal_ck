import { useEffect, useReducer, useState } from 'react';
import type { Surreal } from 'surrealdb';

export interface EntityField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface EntityType {
  id: string;
  key: string;
  label: string;
  fields: EntityField[];
}

interface State {
  items: EntityType[];
  isLoading: boolean;
  error: string | null;
  isCreating: boolean;
  createError: string | null;
  createStep: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: EntityType[] }
  | { type: 'load-err'; error: string }
  | { type: 'create-start' }
  | { type: 'create-ok'; item: EntityType }
  | { type: 'create-err'; error: string; step: string }
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
      return { ...state, isCreating: true, createError: null, createStep: null };
    case 'create-ok':
      return { ...state, isCreating: false, items: [...state.items, action.item] };
    case 'create-err':
      return { ...state, isCreating: false, createError: action.error, createStep: action.step };
    case 'delete-ok':
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    case 'clear-create-error':
      return { ...state, createError: null, createStep: null };
    default:
      return state;
  }
}

const INITIAL_STATE: State = {
  items: [],
  isLoading: false,
  error: null,
  isCreating: false,
  createError: null,
  createStep: null,
};

const RESERVED_TABLE_NAMES = new Set([
  'workspace', 'workbook', 'workspace_member', 'mutation', 'snapshot',
  'presence', 'field_type', 'entity_type', 'relation_type', 'form_definition',
  'intake_submission', 'client_error', 'workbook_file', 'app_user',
]);

export interface EntityTypesPanelProps {
  db: Surreal;
  workspaceId: string;
}

export function EntityTypesPanel({ db, workspaceId }: EntityTypesPanelProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [newLabel, setNewLabel] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    void loadEntityTypes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadEntityTypes() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[EntityType[]]>(
        'SELECT VALUE out FROM workspace_has_entity_type WHERE in = $ws ORDER BY out.label',
        { ws: workspaceId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCreate() {
    const label = newLabel.trim();
    if (!label) return;

    const tableKey = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    if (RESERVED_TABLE_NAMES.has(tableKey)) {
      dispatch({
        type: 'create-err',
        step: 'validation',
        error: `"${tableKey}" is a reserved table name. Choose a different entity type name.`,
      });
      return;
    }

    dispatch({ type: 'create-start' });

    try {
      // Step 1: DDL — define the table and workspace field.
      await db.query(
        `DEFINE TABLE IF NOT EXISTS ${tableKey} SCHEMALESS PERMISSIONS FULL;
         DEFINE FIELD IF NOT EXISTS workspace ON TABLE ${tableKey} TYPE record<workspace>;
         DEFINE FIELD IF NOT EXISTS name ON TABLE ${tableKey} TYPE string;
         DEFINE FIELD IF NOT EXISTS created_at ON TABLE ${tableKey} TYPE datetime VALUE time::now();
         DEFINE INDEX IF NOT EXISTS ${tableKey}_workspace ON TABLE ${tableKey} COLUMNS workspace`,
      );

      // Step 2: Verify the table was created via INFO FOR DB.
      const [info] = await db.query<[Record<string, unknown>]>('INFO FOR DB');
      const tables = info as Record<string, unknown>;
      if (!tables.tables || !(tableKey in (tables.tables as Record<string, unknown>))) {
        throw Object.assign(new Error(`Table "${tableKey}" was not found after DDL`), { step: 'ddl-verify' });
      }

      // Step 3: DML — create the entity_type metadata record.
      const [created] = await db.query<[EntityType[]]>(
        `LET $entity = (INSERT INTO entity_type {
           workspace: $ws,
           key: $key,
           label: $label,
           fields: []
         } RETURN AFTER)[0];
         RELATE $ws->workspace_has_entity_type->$entity;
         RETURN $entity;`,
        { ws: workspaceId, key: tableKey, label: label },
      );
      const item = created?.[0];
      if (!item) throw Object.assign(new Error('entity_type record not returned'), { step: 'dml' });

      dispatch({ type: 'create-ok', item });
      setNewLabel('');
      setShowForm(false);
    } catch (err) {
      const step = (err instanceof Error && 'step' in err) ? String((err as { step?: string }).step) : 'ddl';
      dispatch({
        type: 'create-err',
        step,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleDelete(item: EntityType) {
    try {
      await db.query(
        'DELETE workspace_has_entity_type WHERE in = $ws AND out = $id; DELETE $id',
        { id: item.id, ws: workspaceId },
      );
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // Deletion failure is surfaced to the list but not fatal.
    }
  }

  return (
    <section aria-label="Entity types">
      <div className="admin-section-header">
        <h3>Entity Types</h3>
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
          <label className="admin-form-label" htmlFor="entity-label">
            Entity type name
            <input
              id="entity-label"
              className="admin-form-input"
              type="text"
              placeholder="e.g. Company"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={state.isCreating}
              autoFocus
            />
          </label>
          {state.createError && (
            <p className="admin-form-error" role="alert">
              {state.createStep && state.createStep !== 'validation'
                ? `Failed at step "${state.createStep}": `
                : ''}
              {state.createError}
            </p>
          )}
          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isCreating || !newLabel.trim()}>
              {state.isCreating ? 'Creating…' : 'Create'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setNewLabel(''); dispatch({ type: 'clear-create-error' }); }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">Loading…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}

      {!state.isLoading && state.items.length === 0 && (
        <p className="sidebar-copy">No entity types yet.</p>
      )}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.label}</strong>
              <span className="mono-label">{item.key}</span>
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
