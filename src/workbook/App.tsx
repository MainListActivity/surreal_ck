import { useState } from 'react';

import { useConnectionSnapshot } from '../surreal/client';
import type { ConnectionSnapshot } from '../surreal/types';
import {
  blankWorkbook,
  workspaceSeed,
  type AppScenario,
  type SidebarPanel,
  type TemplateKey,
} from './mock-data';

const panelLabels: Record<SidebarPanel, string> = {
  record: 'Record detail',
  graph: 'Graph results',
  recent: 'Recent changes',
  setup: 'Guided setup',
  admin: 'Admin tools',
};

export interface AppProps {
  initialScenario?: AppScenario;
}

export function App({ initialScenario = 'resume-workbook' }: AppProps) {
  const [screen, setScreen] = useState<'template-picker' | 'workbook'>(
    initialScenario === 'template-picker' ? 'template-picker' : 'workbook',
  );
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const [activeWorkbookId, setActiveWorkbookId] = useState(workspaceSeed.workbooks[0]?.id ?? blankWorkbook.id);
  const [activePanel, setActivePanel] = useState<SidebarPanel>('graph');

  const activeWorkbook =
    workspaceSeed.workbooks.find((workbook) => workbook.id === activeWorkbookId) ?? blankWorkbook;
  const primaryRow = activeWorkbook.rows[0] ?? blankWorkbook.rows[0];
  const connection = useConnectionSnapshot();

  const openWorkbook = (templateKey: TemplateKey) => {
    if (templateKey === 'blank-workspace') {
      setActiveWorkbookId(blankWorkbook.id);
      setActivePanel('setup');
      setScreen('workbook');
      return;
    }

    const nextWorkbook =
      workspaceSeed.workbooks.find((workbook) => workbook.templateKey === templateKey) ?? workspaceSeed.workbooks[0];

    setActiveWorkbookId(nextWorkbook.id);
    setActivePanel(templateKey === 'case-management' ? 'recent' : 'graph');
    setScreen('workbook');
  };

  return (
    <div className={`app-shell ${isRailCollapsed ? 'app-shell--rail-collapsed' : ''}`}>
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
          <div className="rail-workbook-list">
            {workspaceSeed.workbooks.map((workbook) => (
              <button
                key={workbook.id}
                className={`rail-button ${screen === 'workbook' && activeWorkbookId === workbook.id ? 'rail-button--active' : ''}`}
                type="button"
                onClick={() => {
                  setActiveWorkbookId(workbook.id);
                  setActivePanel(workbook.templateKey === 'case-management' ? 'recent' : 'graph');
                  setScreen('workbook');
                }}
              >
                <span>{workbook.name}</span>
                <span className="rail-button__meta">{workbook.updatedAt}</span>
              </button>
            ))}
          </div>
        </div>

        <nav className="rail-section" aria-label="Primary">
          <button
            className={`rail-button ${screen === 'workbook' ? 'rail-button--active' : ''}`}
            type="button"
            onClick={() => setScreen('workbook')}
          >
            Workbook
          </button>
          <button
            className={`rail-button ${screen === 'template-picker' ? 'rail-button--active' : ''}`}
            type="button"
            onClick={() => setScreen('template-picker')}
          >
            Templates
          </button>
          <button className="rail-button" type="button" onClick={() => setActivePanel('recent')}>
            Recent changes
          </button>
          <button className="rail-button" type="button" onClick={() => setActivePanel('admin')}>
            Admin
          </button>
        </nav>

        <div className="rail-meta">
          <span className={`status-chip ${connection.state === 'error' ? 'status-chip--warning' : ''}`}>
            {formatConnectionLabel(connection.state)}
          </span>
          <p>
            Workbook-first scaffolding is live. Univer canvas, collab replay, and Surreal live data plug in next.
          </p>
        </div>
      </aside>

      <main className="canvas-shell">
        {screen === 'template-picker' ? (
          <TemplatePicker onSelectTemplate={openWorkbook} />
        ) : (
          <>
            <header className="top-bar">
              <div>
                <p className="eyebrow">Workspace</p>
                <div className="top-bar__title-row">
                  <h2>{workspaceSeed.name}</h2>
                  <span className="top-bar__divider">/</span>
                  <p className="top-bar__workbook-name">{activeWorkbook.name}</p>
                </div>
              </div>
              <div className="top-bar-meta">
                <span className={`status-chip ${activeWorkbook.syncStatus === 'RECONNECTING' ? 'status-chip--warning' : ''}`}>
                  {activeWorkbook.syncStatus}
                </span>
                <span className="mono-label">{workspaceSeed.memberCount} members</span>
                <button className="secondary-button" type="button">
                  Share & Members
                </button>
                <button className="ghost-button" type="button">
                  {workspaceSeed.userName}
                </button>
              </div>
            </header>

            <section className="canvas-content">
              <div className="sheet-stage" aria-label="Workbook preview">
                <div className="sheet-stage__header">
                  <div>
                    <p className="eyebrow">Action sheet</p>
                    <h3 className="sheet-stage__title">{activeWorkbook.sheetLabel}</h3>
                  </div>
                  <div className="sheet-stage__actions">
                    <button className="ghost-button" type="button" onClick={() => setActivePanel('record')}>
                      Record detail
                    </button>
                    <button className="ghost-button" type="button" onClick={() => setActivePanel('graph')}>
                      Graph results
                    </button>
                    <button className="ghost-button" type="button" onClick={() => setActivePanel('recent')}>
                      Recent changes
                    </button>
                  </div>
                </div>

                <div className="sheet-toolbar">
                  <span className="mono-label">Selection: {primaryRow.id}</span>
                  <span className="mono-label">Formula aware</span>
                  <span className="mono-label">Surreal: {formatConnectionLabel(connection.state)}</span>
                  <span className="mono-label">Realtime presence</span>
                </div>

                <section className="sheet-grid" role="table" aria-label="Workbook preview grid">
                  <div className="sheet-grid__row sheet-grid__row--header" role="row">
                    <span>Entity</span>
                    <span>Jurisdiction</span>
                    <span>Relationship</span>
                    <span>Formula / Value</span>
                    <span>Owner</span>
                  </div>
                  {activeWorkbook.rows.map((row) => (
                    <button
                      key={row.id}
                      className={`sheet-grid__row sheet-grid__row--interactive sheet-grid__row--${row.status}`}
                      type="button"
                      role="row"
                      onClick={() => setActivePanel('record')}
                    >
                      <span>{row.entity}</span>
                      <span>{row.jurisdiction}</span>
                      <span>{row.relationship}</span>
                      <span className="mono-cell">{row.formula}</span>
                      <span>{row.owner}</span>
                    </button>
                  ))}
                </section>

                <section className="mobile-record-view" aria-label="Workbook mobile read only list">
                  <div className="mobile-record-view__header">
                    <p className="eyebrow">Phone mode</p>
                    <h3>Read-only record list</h3>
                  </div>
                  <div className="mobile-record-cards">
                    {activeWorkbook.rows.map((row) => (
                      <article key={row.id} className="mobile-record-card">
                        <div className="mobile-record-card__row">
                          <strong>{row.entity}</strong>
                          <span className={`status-chip status-chip--compact status-chip--${row.status}`}>{row.status}</span>
                        </div>
                        <p>{row.relationship}</p>
                        <p className="mono-cell">{row.id}</p>
                        <button className="secondary-button secondary-button--full" type="button" onClick={() => setActivePanel('record')}>
                          Open detail
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              </div>

              <aside className="sidebar-panel" aria-label={panelLabels[activePanel]}>
                <SidebarPanelContent activePanel={activePanel} workbookName={activeWorkbook.name} />
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
                <span className="status-chip status-chip--warning">Import preview ready</span>
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

function formatConnectionLabel(state: ConnectionSnapshot['state']) {
  switch (state) {
    case 'connected':
      return 'Surreal connected';
    case 'connecting':
      return 'Surreal connecting';
    case 'reconnecting':
      return 'Surreal reconnecting';
    case 'error':
      return 'Surreal error';
    case 'disconnected':
      return 'Surreal offline';
    default:
      return 'Surreal idle';
  }
}

function formatConnectionMeta(connection: ConnectionSnapshot) {
  return connection.detail
    ? `${formatConnectionLabel(connection.state)} · ${connection.detail}`
    : formatConnectionLabel(connection.state);
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
        {workspaceSeed.templates.map((template) => (
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

function SidebarPanelContent({
  activePanel,
  workbookName,
}: {
  activePanel: SidebarPanel;
  workbookName: string;
}) {
  if (activePanel === 'record') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Record detail</p>
        <h2>Acme Holdings</h2>
        <p className="sidebar-copy">
          Primary entity record for the active row. Hover previews and row-driven detail remain attached to the sheet,
          not split into a separate page.
        </p>
        <dl className="detail-list">
          <div>
            <dt>Record ID</dt>
            <dd className="mono-cell">company:acme-holdings</dd>
          </div>
          <div>
            <dt>Entity type</dt>
            <dd>Company</dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd>2 minutes ago</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (activePanel === 'recent') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Recent changes</p>
        <h2>Last 20 mutations</h2>
        <ul className="sidebar-list sidebar-list--flush">
          {workspaceSeed.recentChanges.map((change) => (
            <li key={change.id}>
              <strong>{change.actor}</strong>
              <span>{change.action}</span>
              <span className="mono-label">{change.at}</span>
            </li>
          ))}
        </ul>
      </div>
    );
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

  return (
    <div className="sidebar-panel__content">
      <p className="eyebrow">Graph results</p>
      <h2>{workbookName}</h2>
      <p className="sidebar-copy">
        GRAPH_TRAVERSE displays readable labels in-cell and exposes the full path list here when the selection is
        graph-aware.
      </p>
      <ul className="sidebar-list sidebar-list--flush">
        {workspaceSeed.graphResults.map((result) => (
          <li key={result.recordId}>
            <div>
              <strong>{result.label}</strong>
              <p className="mono-cell">{result.recordId}</p>
            </div>
            <span>{result.entityType}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
