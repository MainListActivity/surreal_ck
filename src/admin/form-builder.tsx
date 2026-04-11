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
  target_sheet: string;    // sheet record ID
  target_label: string;   // sheet label for display
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
  workbookId: string;
}

export function FormBuilderPanel({ db, workspaceId, workbookId }: FormBuilderPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [], isLoading: false, error: null, isSaving: false, saveError: null,
  });
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [targetSheetId, setTargetSheetId] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);

  useEffect(() => {
    void loadForms();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadForms() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[FormDefinition[]]>(
        `SELECT
           id,
           title,
           slug,
           fields,
           target_sheet,
           target_sheet.label AS target_label
         FROM form_definition
         WHERE workspace = $ws
         ORDER BY title`,
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
    const sheetId = targetSheetId.trim();
    if (!title || !sheetId) return;

    const slug = makeSlug(title);
    dispatch({ type: 'save-start' });

    try {
      const [created] = await db.query<[FormDefinition[]]>(
        `LET $form = (INSERT INTO form_definition {
           workspace:        $ws,
           title:            $title,
           slug:             $slug,
           target_sheet:     $sheet,
           fields:           $fields,
           conditional_rules: [],
           auto_edges:       []
         } RETURN AFTER)[0];
         RETURN {
           id:           $form.id,
           title:        $form.title,
           slug:         $form.slug,
           target_sheet: $form.target_sheet,
           target_label: $form.target_sheet.label,
           fields:       $form.fields
         };`,
        { ws: workspaceId, title, slug, sheet: sheetId, fields },
      );
      const item = created?.[0];
      if (!item) throw new Error('form_definition record not returned');

      dispatch({ type: 'save-ok', item });
      setFormTitle('');
      setTargetSheetId('');
      setFields([]);
      setShowForm(false);
    } catch (err) {
      dispatch({ type: 'save-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleDelete(item: FormDefinition) {
    try {
      await db.query(`DELETE $id`, { id: item.id });
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // non-fatal
    }
  }

  const formValid = formTitle.trim() && targetSheetId.trim();

  return (
    <section aria-label="表单构建">
      <div className="admin-section-header">
        <h3>表单构建</h3>
        <button
          className="secondary-button"
          type="button"
          onClick={() => { setShowForm(true); dispatch({ type: 'clear-save-error' }); }}
        >
          新建表单
        </button>
      </div>

      {showForm && (
        <form className="admin-inline-form" onSubmit={(e) => { e.preventDefault(); void handleSave(); }}>
          <label className="admin-form-label" htmlFor="form-title">
            表单标题
            <input
              id="form-title"
              className="admin-form-input"
              type="text"
              placeholder="例如：新客户入职"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              disabled={state.isSaving}
              autoFocus
            />
          </label>
          <label className="admin-form-label" htmlFor="form-target">
            目标工作表（ID）
            <input
              id="form-target"
              className="admin-form-input"
              type="text"
              placeholder="sheet:company_harbor"
              value={targetSheetId}
              onChange={(e) => setTargetSheetId(e.target.value)}
              disabled={state.isSaving}
            />
          </label>

          <div className="admin-field-list">
            <p className="eyebrow">字段</p>
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
                  placeholder="标签"
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
                  必填
                </label>
                <button
                  className="ghost-button"
                  type="button"
                  aria-label="删除字段"
                  onClick={() => removeField(index)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="ghost-button" type="button" onClick={addField}>+ 添加字段</button>
          </div>

          {state.saveError && <p className="admin-form-error" role="alert">{state.saveError}</p>}

          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isSaving || !formValid}>
              {state.isSaving ? '保存中…' : '保存表单'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setFormTitle(''); setTargetSheetId(''); setFields([]); }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">加载中…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}
      {!state.isLoading && state.items.length === 0 && <p className="sidebar-copy">暂无表单。</p>}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.title}</strong>
              <span className="mono-label">/{item.slug} → {item.target_label}</span>
              <span className="sidebar-copy">{item.fields.length} 个字段</span>
            </div>
            <button
              className="ghost-button"
              type="button"
              aria-label={`删除 ${item.title}`}
              onClick={() => void handleDelete(item)}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
