import { useEffect, useRef, useState } from 'react';
import type { Surreal } from 'surrealdb';

import { clientId } from '../../lib/client-id';
import { useConnectionSnapshot } from '../../lib/surreal/client';
import { useSurrealClient } from '../../lib/surreal/provider';
import type { ConnectionSnapshot } from '../../lib/surreal/types';
import type { Sheet } from '../../lib/surreal/types';
import { RecentChangesPanel } from '../../sidebar/recent-changes';
import { bootstrapUniver } from '../../workbook/univer';
import type { UniverInstance } from '../../workbook/univer';
import { templateCatalog, type SidebarPanel, type TemplateKey } from './mock-data';
import { useSheets, type CreateSheetOpts } from './use-sheets';
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

  // Load sheet records for the active workbook so we can pass them to Univer
  const { sheets, createSheet } = useSheets(db, activeWorkbook?.id ?? null, wsKey);

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

                <UniverGrid
                  db={db}
                  workbookId={activeWorkbook?.id ?? null}
                  workspaceId={workspace.data?.id ?? null}
                  wsKey={wsKey}
                  sheets={sheets}
                  createSheet={createSheet}
                />
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

// ─── Univer grid ─────────────────────────────────────────────────────────────

function UniverGrid({
  db,
  workbookId,
  workspaceId,
  wsKey,
  sheets,
  createSheet,
}: {
  db: Surreal;
  workbookId: string | null;
  workspaceId: string | null;
  wsKey: string | null;
  sheets: Sheet[];
  createSheet: (opts: CreateSheetOpts) => Promise<Sheet>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!workbookId || !workspaceId || !containerRef.current) return;

    const container = containerRef.current;
    let instance: UniverInstance | null = null;
    let cancelled = false;

    setStatus('loading');

    bootstrapUniver({
      db,
      workbookId,
      workspaceId,
      clientId,
      container,
      sheets: sheets.length > 0 ? sheets : undefined,
      wsKey: wsKey ?? undefined,
      onSheetAdded: async (univerId, label) => {
        try {
          await createSheet({ label, univerId });
        } catch {
          // Non-fatal — Univer tab exists but DB record may be missing
        }
      },
    })
      .then((inst) => {
        if (cancelled) {
          inst.destroy();
          return;
        }
        instance = inst;
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load spreadsheet');
        setStatus('error');
      });

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  // workbookId triggers a full remount; other deps (sheets, createSheet, wsKey) are captured
  // at mount time intentionally — Univer must not re-bootstrap on every sheet load tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookId, workspaceId]);

  if (!workbookId) {
    return (
      <div className="univer-container univer-container--empty">
        <p className="sidebar-copy">No workbook selected.</p>
      </div>
    );
  }

  return (
    <div className="univer-container" aria-label="Spreadsheet">
      {status === 'loading' && (
        <p className="sidebar-copy" style={{ padding: 'var(--space-xl)' }}>Loading spreadsheet…</p>
      )}
      {status === 'error' && (
        <p className="sidebar-copy" style={{ padding: 'var(--space-xl)', color: 'var(--color-error)' }}>
          {errorMsg ?? 'Spreadsheet failed to load.'}
        </p>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
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
