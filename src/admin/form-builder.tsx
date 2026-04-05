import { useEffect, useReducer, useState } from 'react';
import type { Surreal } from 'surrealdb';

export interface FormField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface FormDefinition {
  id: string;
  title: string;
  slug: string;
  target_table: string;
  fields: FormField[];
}

interface State {
  items: FormDefinition[];
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  saveError: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: FormDefinition[] }
  | { type: 'load-err'; error: string }
  | { type: 'save-start' }
  | { type: 'save-ok'; item: FormDefinition }
  | { type: 'save-err'; error: string }
  | { type: 'delete-ok'; id: string }
  | { type: 'clear-save-error' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { ...state, isLoading: false, items: action.items };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'save-start':
      return { ...state, isSaving: true, saveError: null };
    case 'save-ok':
      return {
        ...state,
        isSaving: false,
        items: state.items.some((i) => i.id === action.item.id)
          ? state.items.map((i) => (i.id === action.item.id ? action.item : i))
          : [...state.items, action.item],
      };
    case 'save-err':
      return { ...state, isSaving: false, saveError: action.error };
    case 'delete-ok':
      return { ...state, items: state.items.filter((i) => i.id !== action.id) };
    case 'clear-save-error':
      return { ...state, saveError: null };
    default:
      return state;
  }
}

const FIELD_TYPES = ['text', 'number', 'date', 'single_select', 'multi_select', 'file'];

function makeSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export interface FormBuilderPanelProps {
  db: Surreal;
  workspaceId: string;
}

export function FormBuilderPanel({ db, workspaceId }: FormBuilderPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [], isLoading: false, error: null, isSaving: false, saveError: null,
  });
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [targetTable, setTargetTable] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);

  useEffect(() => {
    void loadForms();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadForms() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[FormDefinition[]]>(
        'SELECT * FROM form_definition WHERE workspace = $ws ORDER BY title',
        { ws: workspaceId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  function addField() {
    setFields((prev) => [...prev, { key: `field_${prev.length + 1}`, label: '', type: 'text', required: false }]);
  }

  function updateField(index: number, patch: Partial<FormField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  // HTML drag-and-drop for field reordering.
  function handleDragStart(e: React.DragEvent, index: number) {
    e.dataTransfer.setData('text/plain', String(index));
  }

  function handleDrop(e: React.DragEvent, targetIndex: number) {
    e.preventDefault();
    const fromIndex = Number(e.dataTransfer.getData('text/plain'));
    if (fromIndex === targetIndex) return;
    setFields((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  async function handleSave() {
    const title = formTitle.trim();
    const target = targetTable.trim();
    if (!title || !target) return;

    const slug = makeSlug(title);
    dispatch({ type: 'save-start' });

    try {
      const [created] = await db.query<[FormDefinition[]]>(
        `INSERT INTO form_definition {
           workspace: $ws, title: $title, slug: $slug,
           target_table: $target, fields: $fields,
           conditional_rules: [], auto_relations: []
         } RETURN *`,
        { ws: workspaceId, title, slug, target, fields },
      );
      const item = created?.[0];
      if (!item) throw new Error('form_definition record not returned');

      dispatch({ type: 'save-ok', item });
      setFormTitle('');
      setTargetTable('');
      setFields([]);
      setShowForm(false);
    } catch (err) {
      dispatch({ type: 'save-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleDelete(item: FormDefinition) {
    try {
      await db.query('DELETE form_definition WHERE id = $id AND workspace = $ws', { id: item.id, ws: workspaceId });
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // non-fatal
    }
  }

  const formValid = formTitle.trim() && targetTable.trim();

  return (
    <section aria-label="Form builder">
      <div className="admin-section-header">
        <h3>Form Builder</h3>
        <button
          className="secondary-button"
          type="button"
          onClick={() => { setShowForm(true); dispatch({ type: 'clear-save-error' }); }}
        >
          New form
        </button>
      </div>

      {showForm && (
        <form className="admin-inline-form" onSubmit={(e) => { e.preventDefault(); void handleSave(); }}>
          <label className="admin-form-label" htmlFor="form-title">
            Form title
            <input
              id="form-title"
              className="admin-form-input"
              type="text"
              placeholder="e.g. New Client Intake"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              disabled={state.isSaving}
              autoFocus
            />
          </label>
          <label className="admin-form-label" htmlFor="form-target">
            Target entity table
            <input
              id="form-target"
              className="admin-form-input"
              type="text"
              placeholder="e.g. company"
              value={targetTable}
              onChange={(e) => setTargetTable(e.target.value)}
              disabled={state.isSaving}
            />
          </label>

          <div className="admin-field-list">
            <p className="eyebrow">Fields</p>
            {fields.map((field, index) => (
              <div
                key={index}
                className="admin-field-row"
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, index)}
              >
                <span className="admin-field-drag" aria-hidden="true">⠿</span>
                <input
                  className="admin-form-input admin-form-input--sm"
                  type="text"
                  placeholder="Label"
                  value={field.label}
                  onChange={(e) => updateField(index, { label: e.target.value, key: makeSlug(e.target.value) || `field_${index + 1}` })}
                />
                <select
                  className="admin-form-input admin-form-input--sm"
                  value={field.type}
                  onChange={(e) => updateField(index, { type: e.target.value })}
                >
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <label className="admin-field-required">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => updateField(index, { required: e.target.checked })}
                  />
                  Req
                </label>
                <button
                  className="ghost-button"
                  type="button"
                  aria-label="Remove field"
                  onClick={() => removeField(index)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="ghost-button" type="button" onClick={addField}>+ Add field</button>
          </div>

          {state.saveError && <p className="admin-form-error" role="alert">{state.saveError}</p>}

          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isSaving || !formValid}>
              {state.isSaving ? 'Saving…' : 'Save form'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setFormTitle(''); setTargetTable(''); setFields([]); }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">Loading…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}
      {!state.isLoading && state.items.length === 0 && <p className="sidebar-copy">No forms yet.</p>}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.title}</strong>
              <span className="mono-label">/{item.slug} → {item.target_table}</span>
              <span className="sidebar-copy">{item.fields.length} field{item.fields.length !== 1 ? 's' : ''}</span>
            </div>
            <button
              className="ghost-button"
              type="button"
              aria-label={`Delete ${item.title}`}
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
