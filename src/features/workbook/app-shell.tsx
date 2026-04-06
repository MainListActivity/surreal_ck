import { useState } from 'react';

import { useConnectionSnapshot } from '../../lib/surreal/client';
import { useSurrealClient } from '../../lib/surreal/provider';
import type { ConnectionSnapshot } from '../../lib/surreal/types';
import { RecentChangesPanel } from '../../sidebar/recent-changes';
import { templateCatalog, type SidebarPanel, type TemplateKey } from './mock-data';
import { formatUpdatedAt, useWorkspace } from './use-workspace';

const panelLabels: Record<SidebarPanel, string> = {
  record: 'Record detail',
  graph: 'Graph results',
  recent: 'Recent changes',
  setup: 'Guided setup',
  admin: 'Admin tools',
};

export interface AppShellProps {
  view: 'template-picker' | 'workbook';
  activeWorkbookId?: string;
  activePanel?: SidebarPanel;
  displayName?: string;
  onSelectTemplate: (templateKey: TemplateKey) => void;
  onSelectWorkbook: (workbookId: string) => void;
  onSelectPanel: (panel: SidebarPanel) => void;
  onShowTemplates: () => void;
  onShowAdmin: () => void;
  onLogout?: () => void;
}

export function AppShell({
  view,
  activeWorkbookId,
  activePanel = 'graph',
  displayName,
  onSelectTemplate,
  onSelectWorkbook,
  onSelectPanel,
  onShowTemplates,
  onShowAdmin,
  onLogout,
}: AppShellProps) {
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const db = useSurrealClient();
  const workspace = useWorkspace(db);
  const connection = useConnectionSnapshot();

  const isOffline = connection.state === 'reconnecting' || connection.state === 'disconnected';

  const workbooks = workspace.data?.workbooks ?? [];
  const workspaceName = workspace.data?.name ?? '…';
  const memberCount = workspace.data?.memberCount ?? 0;
  // Extract ws_key from record ID: "workspace:harbor" → "harbor"
  const wsKey = workspace.data?.id?.split(':')[1] ?? null;
  const resolvedDisplayName = displayName ?? '…';

  // Determine the active workbook, falling back to the first available.
  const activeWorkbook = workbooks.find((wb) => wb.id === activeWorkbookId) ?? workbooks[0] ?? null;

  return (
    <div className={`app-shell ${isRailCollapsed ? 'app-shell--rail-collapsed' : ''}`}>
      {isOffline && (
        <div className="reconnect-banner" role="status" aria-live="polite">
          <span className="reconnect-banner__dot" aria-hidden="true" />
          {connection.state === 'reconnecting' ? 'Reconnecting to workspace…' : 'Connection lost — working offline'}
        </div>
      )}
      <aside className="left-rail" aria-label="Workbook navigation">
        <div className="left-rail__header">
          <div>
            <p className="eyebrow">surreal_ck</p>
            <h1 className="workbook-title">Graph workbook</h1>
          </div>
          <button
            className="ghost-button ghost-button--icon"
            type="button"
            aria-label={isRailCollapsed ? 'Expand navigation rail' : 'Collapse navigation rail'}
            onClick={() => setIsRailCollapsed((value) => !value)}
          >
            {isRailCollapsed ? '→' : '←'}
          </button>
        </div>

        <div className="rail-block">
          <p className="eyebrow">Workbook switcher</p>
          {workspace.isLoading && <p className="sidebar-copy">Loading…</p>}
          {workspace.error && <p className="sidebar-copy">{workspace.error}</p>}
          <div className="rail-workbook-list">
            {workbooks.map((workbook) => (
              <button
                key={workbook.id}
                className={`rail-button ${view === 'workbook' && activeWorkbookId === workbook.id ? 'rail-button--active' : ''}`}
                type="button"
                onClick={() => { onSelectWorkbook(workbook.id); }}
              >
                <span>{workbook.name}</span>
                <span className="rail-button__meta">{formatUpdatedAt(workbook.updated_at)}</span>
              </button>
            ))}
          </div>
        </div>

        <nav className="rail-section" aria-label="Primary">
          <button
            className={`rail-button ${view === 'workbook' ? 'rail-button--active' : ''}`}
            type="button"
            onClick={() => { if (activeWorkbook) onSelectWorkbook(activeWorkbook.id); }}
          >
            Workbook
          </button>
          <button
            className={`rail-button ${view === 'template-picker' ? 'rail-button--active' : ''}`}
            type="button"
            onClick={onShowTemplates}
          >
            Templates
          </button>
          <button className="rail-button" type="button" onClick={() => onSelectPanel('recent')}>
            Recent changes
          </button>
          <button className="rail-button" type="button" onClick={onShowAdmin}>
            Admin
          </button>
        </nav>

        <div className="rail-meta">
          <span
            className={`status-chip ${connection.state === 'error' || connection.state === 'auth-failed' ? 'status-chip--warning' : ''}`}
          >
            {formatConnectionLabel(connection.state)}
          </span>
        </div>
      </aside>

      <main className="canvas-shell">
        {view === 'template-picker' ? (
          <TemplatePicker onSelectTemplate={onSelectTemplate} />
        ) : (
          <>
            <header className="top-bar">
              <div>
                <p className="eyebrow">Workspace</p>
                <div className="top-bar__title-row">
                  <h2>{workspaceName}</h2>
                  {activeWorkbook && (
                    <>
                      <span className="top-bar__divider">/</span>
                      <p className="top-bar__workbook-name">{activeWorkbook.name}</p>
                    </>
                  )}
                </div>
              </div>
              <div className="top-bar-meta">
                <span className={`status-chip ${connection.state !== 'connected' ? 'status-chip--warning' : ''}`}>
                  {connection.state === 'connected' ? 'LIVE SYNC' : 'RECONNECTING'}
                </span>
                <span className="mono-label">{memberCount} members</span>
                <button className="secondary-button" type="button">
                  Share & Members
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => { onLogout?.(); }}
                >
                  {resolvedDisplayName}
                </button>
              </div>
            </header>

            <section className="canvas-content">
              <div className="sheet-stage" aria-label="Workbook preview">
                <div className="sheet-stage__header">
                  <div>
                    <p className="eyebrow">Action sheet</p>
                    <h3 className="sheet-stage__title">
                      {activeWorkbook ? `Action Sheet: ${activeWorkbook.name}` : 'Select a workbook'}
                    </h3>
                  </div>
                  <div className="sheet-stage__actions">
                    <button className="ghost-button" type="button" onClick={() => onSelectPanel('record')}>
                      Record detail
                    </button>
                    <button className="ghost-button" type="button" onClick={() => onSelectPanel('graph')}>
                      Graph results
                    </button>
                    <button className="ghost-button" type="button" onClick={() => onSelectPanel('recent')}>
                      Recent changes
                    </button>
                  </div>
                </div>

                <div className="sheet-toolbar">
                  <span className="mono-label">Selection: {activeWorkbook?.id ?? '—'}</span>
                  <span className="mono-label">Formula aware</span>
                  <span className="mono-label">Surreal: {formatConnectionLabel(connection.state)}</span>
                  <span className="mono-label">Realtime presence</span>
                </div>

                <WorkbookGrid db={db} workbook={activeWorkbook} wsKey={wsKey} onSelectPanel={onSelectPanel} />
              </div>

              <aside className="sidebar-panel" aria-label={panelLabels[activePanel]}>
                <SidebarPanelContent
                  db={db}
                  activePanel={activePanel}
                  workbookId={activeWorkbook?.id ?? ''}
                  workbookName={activeWorkbook?.name ?? ''}
                />
              </aside>
            </section>

            <footer className="status-bar" aria-label="Application status">
              <div className="status-bar__group">
                <span className={`status-chip ${connection.state === 'connected' ? '' : 'status-chip--warning'}`}>
                  {connection.state === 'connected' ? 'Sync stable' : 'Sync pending'}
                </span>
                <span className="mono-label">Surreal: {formatConnectionMeta(connection)}</span>
              </div>
              <div className="status-bar__group">
                <span className="mono-label">Reconnect queue: 0</span>
                <span className="mono-label">Warnings: none</span>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

// ─── Workbook grid (live entity rows from SurrealDB) ──────────────────────────

import { useEffect, useReducer } from 'react';
import type { Surreal } from 'surrealdb';
import { templateToEntityTable } from './use-workspace';
import type { WorkbookSummaryDb } from './use-workspace';

interface EntityRow {
  id: string;
  name: string;
  jurisdiction: string | null;
  status: string | null;
}

interface GridState {
  rows: EntityRow[];
  isLoading: boolean;
  error: string | null;
}

type GridAction =
  | { type: 'load-start' }
  | { type: 'load-ok'; rows: EntityRow[] }
  | { type: 'load-err'; error: string };

function gridReducer(state: GridState, action: GridAction): GridState {
  switch (action.type) {
    case 'load-start': return { ...state, isLoading: true, error: null };
    case 'load-ok':    return { rows: action.rows, isLoading: false, error: null };
    case 'load-err':   return { ...state, isLoading: false, error: action.error };
    default:           return state;
  }
}

function WorkbookGrid({
  db,
  workbook,
  wsKey,
  onSelectPanel,
}: {
  db: Surreal;
  workbook: WorkbookSummaryDb | null;
  wsKey: string | null;
  onSelectPanel: (panel: SidebarPanel) => void;
}) {
  const [state, dispatch] = useReducer(gridReducer, { rows: [], isLoading: false, error: null });

  useEffect(() => {
    if (!workbook) return;
    const table = templateToEntityTable(wsKey, workbook.template_key);
    if (!table) return;

    let cancelled = false;
    dispatch({ type: 'load-start' });

    db.query<[EntityRow[]]>(
      `SELECT id, name, jurisdiction, status FROM type::table($table) LIMIT 50`,
      { table },
    )
      .then(([rows]) => {
        // SurrealDB 2.x returns RecordId objects for id fields, not plain strings.
        // Coerce to string here so JSX renders correctly.
        const normalised = (rows ?? []).map((r) => ({ ...r, id: String(r.id) }));
        if (!cancelled) dispatch({ type: 'load-ok', rows: normalised });
      })
      .catch((err) => {
        if (!cancelled) dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Query failed' });
      });

    return () => { cancelled = true; };
  }, [db, workbook?.id, workbook?.template_key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!workbook) {
    return (
      <section className="sheet-grid" role="table" aria-label="Workbook preview grid">
        <p className="sidebar-copy">No workbook selected.</p>
      </section>
    );
  }

  return (
    <>
      <section className="sheet-grid" role="table" aria-label="Workbook preview grid">
        <div className="sheet-grid__row sheet-grid__row--header" role="row">
          <span>Entity</span>
          <span>Jurisdiction</span>
          <span>Status</span>
          <span>Record ID</span>
        </div>
        {state.isLoading && (
          <div className="sheet-grid__row" role="row">
            <span>Loading…</span>
          </div>
        )}
        {state.error && (
          <div className="sheet-grid__row" role="row">
            <span style={{ color: 'var(--color-error)' }}>{state.error}</span>
          </div>
        )}
        {!state.isLoading && state.rows.map((row) => (
          <button
            key={row.id}
            className="sheet-grid__row sheet-grid__row--interactive"
            type="button"
            role="row"
            onClick={() => onSelectPanel('record')}
          >
            <span>{row.name}</span>
            <span>{row.jurisdiction ?? '—'}</span>
            <span>{row.status ?? '—'}</span>
            <span className="mono-cell">{row.id}</span>
          </button>
        ))}
      </section>

      <section className="mobile-record-view" aria-label="Workbook mobile read only list">
        <div className="mobile-record-view__header">
          <p className="eyebrow">Phone mode</p>
          <h3>Read-only record list</h3>
        </div>
        <div className="mobile-record-cards">
          {state.rows.map((row) => (
            <article key={row.id} className="mobile-record-card">
              <div className="mobile-record-card__row">
                <strong>{row.name}</strong>
                {row.status && (
                  <span className="status-chip status-chip--compact">{row.status}</span>
                )}
              </div>
              <p>{row.jurisdiction ?? '—'}</p>
              <p className="mono-cell">{row.id}</p>
              <button className="secondary-button secondary-button--full" type="button" onClick={() => onSelectPanel('record')}>
                Open detail
              </button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

// ─── Sidebar panels ───────────────────────────────────────────────────────────

function SidebarPanelContent({
  db,
  activePanel,
  workbookId,
  workbookName,
}: {
  db: Surreal;
  activePanel: SidebarPanel;
  workbookId: string;
  workbookName: string;
}) {
  if (activePanel === 'record') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Record detail</p>
        <h2>Select a record</h2>
        <p className="sidebar-copy">
          Click any row in the grid to view the full record detail here.
        </p>
      </div>
    );
  }

  if (activePanel === 'recent') {
    return <RecentChangesPanel db={db} workbookId={workbookId} />;
  }

  if (activePanel === 'setup') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Guided setup</p>
        <h2>Exactly three first actions</h2>
        <ol className="sidebar-list sidebar-list--numbered">
          <li>Create the first entity type</li>
          <li>Create the first relationship type</li>
          <li>Create the first intake form</li>
        </ol>
        <p className="sidebar-copy">
          Blank workspaces still open directly into the sheet. The setup panel is attached context, not a detour.
        </p>
      </div>
    );
  }

  if (activePanel === 'admin') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Admin tools</p>
        <h2>Schema controls stay in the workbook shell</h2>
        <ul className="sidebar-list sidebar-list--flush">
          <li>Entity Types</li>
          <li>Relationship Types</li>
          <li>Form Builder</li>
          <li>Workspace Members</li>
        </ul>
        <p className="sidebar-copy">Admin work remains a docked panel so users never lose sheet context.</p>
      </div>
    );
  }

  // Default: graph panel
  return (
    <div className="sidebar-panel__content">
      <p className="eyebrow">Graph results</p>
      <h2>{workbookName}</h2>
      <p className="sidebar-copy">
        GRAPH_TRAVERSE displays readable labels in-cell and exposes the full path list here when the selection is
        graph-aware.
      </p>
    </div>
  );
}

function formatConnectionLabel(state: ConnectionSnapshot['state']) {
  switch (state) {
    case 'connected':    return 'Surreal connected';
    case 'connecting':   return 'Surreal connecting';
    case 'reconnecting': return 'Surreal reconnecting';
    case 'auth-failed':  return 'Surreal auth failed';
    case 'error':        return 'Surreal error';
    case 'disconnected': return 'Surreal offline';
    default:             return 'Surreal idle';
  }
}

function formatConnectionMeta(connection: ConnectionSnapshot) {
  return connection.detail
    ? `${formatConnectionLabel(connection.state)} · ${connection.detail}`
    : formatConnectionLabel(connection.state);
}

export function AuthScreen({
  title,
  body,
  error,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  error?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <main className="canvas-shell">
      <section className="template-picker" aria-label="Authentication">
        <div className="template-picker__hero">
          <div>
            <p className="eyebrow">Authentication</p>
            <h2 className="template-picker__title">{title}</h2>
          </div>
          <p className="template-picker__copy">{body}</p>
          {error ? <p className="template-picker__copy">Last error: {error}</p> : null}
          {actionLabel && onAction ? (
            <button className="primary-button" type="button" onClick={onAction}>
              {actionLabel}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function TemplatePicker({ onSelectTemplate }: { onSelectTemplate: (templateKey: TemplateKey) => void }) {
  return (
    <section className="template-picker" aria-label="Template picker">
      <div className="template-picker__hero">
        <div>
          <p className="eyebrow">First run</p>
          <h2 className="template-picker__title">Start in a workbook, not a dashboard.</h2>
        </div>
        <p className="template-picker__copy">
          Choose a template and land directly in a populated sheet. The workbook remains the primary surface from the
          first minute.
        </p>
      </div>

      <div className="template-grid">
        {templateCatalog.map((template) => (
          <article key={template.key} className="template-card">
            <p className="eyebrow">Template</p>
            <h3>{template.name}</h3>
            <p className="template-card__copy">{template.description}</p>
            <dl className="template-card__facts">
              <div>
                <dt>Relations</dt>
                <dd>{template.accent}</dd>
              </div>
              <div>
                <dt>Entities</dt>
                <dd>{template.entityTypes.length > 0 ? template.entityTypes.join(', ') : 'Defined by admin'}</dd>
              </div>
              <div>
                <dt>Sample form</dt>
                <dd>{template.sampleForm}</dd>
              </div>
            </dl>
            <button className="primary-button" type="button" onClick={() => onSelectTemplate(template.key)}>
              Open {template.name}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
