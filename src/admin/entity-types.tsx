import { useEffect, useReducer, useState } from 'react';
import type { Surreal } from 'surrealdb';

import { entityTableDDL, relationTableDDL, validateTableKey, type FieldDef } from '../lib/surreal/ddl';
import { toRecordId } from '../lib/surreal/record-id';

export interface EntityField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

// A Sheet is the user-facing concept. Each sheet maps 1:1 to a physical entity table.
export interface SheetSummary {
  id: string;
  label: string;
  table_name: string;
  column_defs: EntityField[];
}

interface State {
  items: SheetSummary[];
  isLoading: boolean;
  error: string | null;
  isCreating: boolean;
  createError: string | null;
  createStep: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: SheetSummary[] }
  | { type: 'load-err'; error: string }
  | { type: 'create-start' }
  | { type: 'create-ok'; item: SheetSummary }
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

// Validation is delegated to ddl.ts — see validateTableKey()

export interface EntityTypesPanelProps {
  db: Surreal;
  workspaceId: string;
  workbookId: string;
  wsKey: string; // workspace nanoid used in table name prefix, e.g. "harbor"
}

export function EntityTypesPanel({ db, workspaceId, workbookId, wsKey }: EntityTypesPanelProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [newLabel, setNewLabel] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    void loadSheets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId]);

  async function loadSheets() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[SheetSummary[]]>(
        `SELECT id, label, table_name, column_defs
         FROM sheet WHERE workbook = $wb ORDER BY position`,
        { wb: workbookId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCreate() {
    const label = newLabel.trim();
    if (!label) return;

    const entityKey = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const tableName = `ent_${wsKey}_${entityKey}`;

    const keyErr = validateTableKey(tableName);
    if (keyErr) {
      dispatch({ type: 'create-err', step: 'validation', error: keyErr });
      return;
    }

    dispatch({ type: 'create-start' });

    try {
      // Step 1: DDL — create the physical entity table with workspace-scoped permissions.
      const defaultFields: FieldDef[] = [{ key: 'name', type: 'text', required: true }];
      await db.query(entityTableDDL(tableName, defaultFields));

      // Step 2: Create sheet record（sheet.workbook 字段即关联，无需额外的边）
      const [created] = await db.query<[SheetSummary[]]>(
        `BEGIN TRANSACTION;
         LET $sheet = (CREATE sheet CONTENT {
           workbook:    $wb,
           univer_id:   rand::ulid(),
           table_name:  $table_name,
           label:       $label,
           position:    (SELECT count() FROM sheet WHERE workbook = $wb)[0].count ?? 0,
           column_defs: [{ key: "name", label: "Name", field_type: "text", required: true }]
         } RETURN AFTER)[0];
         RETURN $sheet;
         COMMIT TRANSACTION`,
        { wb: workbookId, table_name: tableName, label },
      );
      const item = created?.[0];
      if (!item) throw Object.assign(new Error('sheet record not returned'), { step: 'dml' });

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

  async function handleDelete(item: SheetSummary) {
    try {
      // 删除 sheet 记录。物理实体表（item.table_name）保留 —
      // REMOVE TABLE 不可逆，误操作风险高。
      await db.query(
        `DELETE $id`,
        { id: toRecordId(item.id) },
      );
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // Deletion failure is surfaced to the list but not fatal.
    }
  }

  return (
    <section aria-label="实体类型">
      <div className="admin-section-header">
        <h3>实体类型</h3>
        <button
          className="secondary-button"
          type="button"
          onClick={() => { setShowForm(true); dispatch({ type: 'clear-create-error' }); }}
        >
          添加
        </button>
      </div>

      {showForm && (
        <form
          className="admin-inline-form"
          onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
        >
          <label className="admin-form-label" htmlFor="entity-label">
            实体类型名称
            <input
              id="entity-label"
              className="admin-form-input"
              type="text"
              placeholder="例如：公司"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={state.isCreating}
              autoFocus
            />
          </label>
          {state.createError && (
            <p className="admin-form-error" role="alert">
              {state.createStep && state.createStep !== 'validation'
                ? `步骤"${state.createStep}"失败：`
                : ''}
              {state.createError}
            </p>
          )}
          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isCreating || !newLabel.trim()}>
              {state.isCreating ? '创建中…' : '创建'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setNewLabel(''); dispatch({ type: 'clear-create-error' }); }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">加载中…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}

      {!state.isLoading && state.items.length === 0 && (
        <p className="sidebar-copy">暂无实体类型。</p>
      )}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.label}</strong>
              <span className="mono-label">{item.table_name}</span>
            </div>
            <button
              className="ghost-button"
              type="button"
              aria-label={`删除 ${item.label}`}
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
