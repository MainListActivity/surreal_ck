import { useEffect, useReducer, useState } from 'react';
import type { DbAdapter } from '../lib/surreal/db-adapter';

import { validateTableKey } from '../lib/surreal/ddl';
import { execDdlTemplate } from '../lib/surreal/ddl-proxy';

import { toRecordId } from '../lib/surreal/record-id';

export interface EdgeCatalogItem {
  id: string;
  key: string;
  label: string;
  rel_table: string;
  from_table: string | null;
  to_table: string | null;
}

interface State {
  items: EdgeCatalogItem[];
  isLoading: boolean;
  error: string | null;
  isCreating: boolean;
  createError: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: EdgeCatalogItem[] }
  | { type: 'load-err'; error: string }
  | { type: 'create-start' }
  | { type: 'create-ok'; item: EdgeCatalogItem }
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
  db: DbAdapter;
  workspaceId: string;
  wsKey: string; // workspace nanoid used in table name prefix, e.g. "harbor"
}

export function RelationTypesPanel({ db, workspaceId, wsKey }: RelationTypesPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [], isLoading: false, error: null, isCreating: false, createError: null,
  });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ label: '', fromTable: '', toTable: '' });

  useEffect(() => {
    void loadEdgeCatalog();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadEdgeCatalog() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[EdgeCatalogItem[]]>(
        `SELECT id, key, label, rel_table, from_table, to_table
         FROM edge_catalog WHERE workspace = $ws ORDER BY label`,
        { ws: workspaceId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCreate() {
    const label = form.label.trim();
    const fromTable = form.fromTable.trim() || null;
    const toTable = form.toTable.trim() || null;
    if (!label) return;

    const key = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const relTable = `rel_${wsKey}_${key}`;

    const keyErr = validateTableKey(relTable);
    if (keyErr) {
      dispatch({ type: 'create-err', error: keyErr });
      return;
    }

    dispatch({ type: 'create-start' });

    try {
      // Step 1: DDL — local-first 架构下主进程有 root 权限，直接执行（no-op execDdlTemplate）
      await execDdlTemplate('', 'ddl-relation-table', { table_name: relTable });

      // Step 2: Register in edge_catalog.
      const [created] = await db.query<[EdgeCatalogItem[]]>(
        `INSERT INTO edge_catalog {
           workspace:  $ws,
           key:        $key,
           label:      $label,
           rel_table:  $rel_table,
           from_table: $from_table,
           to_table:   $to_table,
           edge_props: []
         } RETURN AFTER`,
        { ws: workspaceId, key, label, rel_table: relTable, from_table: fromTable, to_table: toTable },
      );
      const item = created?.[0];
      if (!item) throw new Error('edge_catalog record not returned');

      dispatch({ type: 'create-ok', item });
      setForm({ label: '', fromTable: '', toTable: '' });
      setShowForm(false);
    } catch (err) {
      dispatch({ type: 'create-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleDelete(item: EdgeCatalogItem) {
    try {
      // Remove the catalog record. The physical relation table is left in place
      // to avoid accidental data loss (same reasoning as entity table deletion).
      await db.query(`DELETE $id`, { id: toRecordId(item.id) });
      dispatch({ type: 'delete-ok', id: item.id });
    } catch {
      // non-fatal
    }
  }

  const formValid = form.label.trim();

  return (
    <section aria-label="关系类型">
      <div className="admin-section-header">
        <h3>关系类型</h3>
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
          <label className="admin-form-label" htmlFor="rel-label">
            标签
            <input
              id="rel-label"
              className="admin-form-input"
              type="text"
              placeholder="例如：拥有"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              disabled={state.isCreating}
              autoFocus
            />
          </label>
          <label className="admin-form-label" htmlFor="rel-from">
            来源表（可选）
            <input
              id="rel-from"
              className="admin-form-input"
              type="text"
              placeholder={`例如：ent_${wsKey}_company`}
              value={form.fromTable}
              onChange={(e) => setForm((f) => ({ ...f, fromTable: e.target.value }))}
              disabled={state.isCreating}
            />
          </label>
          <label className="admin-form-label" htmlFor="rel-to">
            目标表（可选）
            <input
              id="rel-to"
              className="admin-form-input"
              type="text"
              placeholder={`例如：ent_${wsKey}_company`}
              value={form.toTable}
              onChange={(e) => setForm((f) => ({ ...f, toTable: e.target.value }))}
              disabled={state.isCreating}
            />
          </label>
          {state.createError && (
            <p className="admin-form-error" role="alert">{state.createError}</p>
          )}
          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isCreating || !formValid}>
              {state.isCreating ? '创建中…' : '创建'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setForm({ label: '', fromTable: '', toTable: '' }); }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">加载中…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}
      {!state.isLoading && state.items.length === 0 && <p className="sidebar-copy">暂无关系类型。</p>}

      <ul className="admin-list" role="list">
        {state.items.map((item) => (
          <li key={item.id} className="admin-list-item">
            <div>
              <strong>{item.label}</strong>
              <span className="mono-label">
                {item.from_table ?? '任意'} → {item.to_table ?? '任意'}
              </span>
              <span className="mono-label">{item.rel_table}</span>
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
