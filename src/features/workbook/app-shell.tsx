import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { Surreal } from 'surrealdb';

import { AdminSidebar } from '../../admin/admin-sidebar';
import { DocTreePanel } from '../my-docs/doc-tree-panel';
import { FolderContentsPane } from '../my-docs/folder-contents-pane';
import { clientId } from '../../lib/client-id';
import { useConnectionSnapshot } from '../../lib/surreal/client';
import { useSurrealClient } from '../../lib/surreal/provider';
import type { ConnectionSnapshot, Sheet } from '../../lib/surreal/types';
import { GraphResultsPanel } from '../../sidebar/graph-results';
import { RecentChangesPanel } from '../../sidebar/recent-changes';
import { provisionTemplate } from '../../shell/template-provisioning';
import { bootstrapUniver } from '../../workbook/univer';
import type { UniverInstance } from '../../workbook/univer';
import { findTemplate, getPublishSlug, templateCatalog, type SidebarPanel, type TemplateKey } from './mock-data';
import { useSheets, type CreateSheetOpts } from './use-sheets';
import { formatUpdatedAt, useWorkspace } from './use-workspace';

const panelLabels: Record<SidebarPanel, string> = {
  none: 'No panel',
  record: 'Claim detail',
  graph: 'Data lineage',
  history: 'Recent activity',
  review: 'Review queue',
  ai: 'AI assistant',
  admin: 'Admin tools',
};

export interface AppShellProps {
  view: 'home' | 'editor';
  activeWorkbookId?: string;
  activePanel?: SidebarPanel;
  displayName?: string;
  ownerUserId?: string;
  showTemplateGallery?: boolean;
  onSelectWorkbook: (workbookId: string) => void;
  onSelectPanel: (panel: SidebarPanel) => void;
  onShowHome: () => void;
  onShowTemplates: () => void;
  onShowAdmin: () => void;
  onOpenPublishedForm: (workspaceId: string, formSlug: string) => void;
  onLogout?: () => void;
}

export function AppShell({
  view,
  activeWorkbookId,
  activePanel = 'none',
  displayName,
  ownerUserId,
  showTemplateGallery = false,
  onSelectWorkbook,
  onSelectPanel,
  onShowHome,
  onShowTemplates,
  onShowAdmin,
  onOpenPublishedForm,
  onLogout,
}: AppShellProps) {
  const db = useSurrealClient();
  const workspace = useWorkspace(db);
  const connection = useConnectionSnapshot();
  const [search, setSearch] = useState('');
  const [isCreating, setIsCreating] = useState<TemplateKey | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeHomeTab, setActiveHomeTab] = useState<'recent' | 'my-docs'>('recent');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  const isOffline = connection.state === 'reconnecting' || connection.state === 'disconnected';
  const workbooks = workspace.data?.workbooks ?? [];
  const workspaceId = workspace.data?.id ?? null;
  const wsKey = workspaceId?.split(':')[1] ?? null;
  const workspaceName = workspace.data?.name ?? '敏感债权协作空间';
  const activeWorkbook = workbooks.find((wb) => wb.id === activeWorkbookId) ?? workbooks[0] ?? null;
  const activeTemplate = findTemplate((activeWorkbook?.template_key as TemplateKey | null | undefined) ?? null);

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const filteredWorkbooks = deferredSearch.length === 0
    ? workbooks
    : workbooks.filter((workbook) => {
      const haystack = `${workbook.name} ${workbook.template_key ?? ''}`.toLowerCase();
      return haystack.includes(deferredSearch);
    });

  useEffect(() => {
    if (view === 'editor' && !activeWorkbookId && activeWorkbook) {
      onSelectWorkbook(activeWorkbook.id);
    }
  }, [view, activeWorkbookId, activeWorkbook, onSelectWorkbook]);

  async function handleCreateWorkbook(templateKey: TemplateKey) {
    if (!ownerUserId) {
      setCreateError('当前登录信息未提供工作区所有者标识，无法创建工作簿。');
      return;
    }

    const template = findTemplate(templateKey);
    if (!template) {
      setCreateError('未找到对应的工作簿模板。');
      return;
    }

    setCreateError(null);
    setIsCreating(templateKey);

    const slug = `${templateKey}-${Date.now().toString(36)}`;
    const result = await provisionTemplate(
      db,
      templateKey,
      `${workspaceName} · ${template.defaultWorkbookName}`,
      slug,
      ownerUserId,
    );

    setIsCreating(null);

    if (!result.ok) {
      setCreateError(`创建失败：${result.step} · ${result.message}`);
      return;
    }

    startTransition(() => {
      onSelectWorkbook(result.workbookId);
    });
  }

  if (view === 'editor') {
    return (
      <div className="ck-page ck-page--editor">
        <EditorChrome
          db={db}
          displayName={displayName}
          workspaceId={workspaceId}
          wsKey={wsKey}
          workspaceName={workspaceName}
          workbooks={workbooks}
          activeWorkbook={activeWorkbook}
          activeWorkbookId={activeWorkbookId}
          activePanel={activePanel}
          activeTemplate={activeTemplate}
          isWorkspaceLoading={workspace.isLoading}
          workspaceError={workspace.error}
          connection={connection}
          onSelectWorkbook={onSelectWorkbook}
          onSelectPanel={onSelectPanel}
          onShowHome={onShowHome}
          onShowAdmin={onShowAdmin}
          onOpenPublishedForm={onOpenPublishedForm}
          onLogout={onLogout}
        />
      </div>
    );
  }

  return (
    <div className="ck-page ck-page--home">
      <ConnectionBanner connection={connection} />
      <div className="tdocs-shell">
        {/* Top bar */}
        <header className="tdocs-topbar">
          <div className="tdocs-topbar__brand">
            <svg className="tdocs-logo" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect width="8.5" height="8.5" rx="2" fill="#2F6BFF" />
              <rect x="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.6" />
              <rect y="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.6" />
              <rect x="11.5" y="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.3" />
            </svg>
            <span className="tdocs-topbar__name">债权文档</span>
          </div>
          <label className="tdocs-search" aria-label="搜索文档">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m11 11 2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              placeholder="搜索文档、模板、工作区（⌘F）"
              value={search}
              onChange={(event) => {
                startTransition(() => {
                  setSearch(event.target.value);
                });
              }}
            />
          </label>
          <div className="tdocs-topbar__right">
            <span className="tdocs-connection-chip" data-state={connection.state}>
              {formatConnectionLabel(connection.state)}
            </span>
            {displayName ? (
              <button className="tdocs-avatar" type="button" aria-label={displayName} title={displayName}>
                {displayName.slice(0, 1).toUpperCase()}
              </button>
            ) : null}
          </div>
        </header>

        <div className="tdocs-body">
          {/* Left rail */}
          <aside className="tdocs-rail" aria-label="导航">
            <div className="tdocs-rail__new">
              <button
                className="tdocs-new-btn"
                type="button"
                disabled={isCreating !== null}
                onClick={() => { void handleCreateWorkbook('legal-entity-tracker'); }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                新建
              </button>
            </div>

            <nav className="tdocs-rail__nav">
              <button className="tdocs-rail-item tdocs-rail-item--active" type="button" onClick={onShowHome}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 6.5 8 2l6 4.5V14H10v-4H6v4H2z" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />
                </svg>
                首页
              </button>
              <button
                className={`tdocs-rail-item ${activeHomeTab === 'my-docs' ? 'tdocs-rail-item--active' : ''}`}
                type="button"
                onClick={() => {
                  startTransition(() => {
                    setActiveHomeTab('my-docs');
                  });
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                我的文档
              </button>
              <button className="tdocs-rail-item" type="button" onClick={onShowAdmin}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 2v2M8 12v2M2 8h2M12 8h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                工作区设置
              </button>
              <button className="tdocs-rail-item" type="button">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M5 8h6M5 5.5h4M5 10.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                空间
              </button>
            </nav>

            {activeHomeTab === 'my-docs' && workspaceId ? (
              <DocTreePanel
                db={db}
                workspaceId={workspaceId}
                selectedFolderId={selectedFolderId}
                onSelectFolder={setSelectedFolderId}
              />
            ) : null}

            <div className="tdocs-rail__footer">
              <p className="tdocs-rail__workspace-label">{workspaceName}</p>
              <p className="tdocs-rail__trust">受控协作空间 · 留痕审计</p>
            </div>
          </aside>

          {/* Main content */}
          <main className="tdocs-main">
            {/* Tab bar */}
            <div className="tdocs-tabs" role="tablist">
              <button
                className={`tdocs-tab ${activeHomeTab === 'recent' ? 'tdocs-tab--active' : ''}`}
                role="tab"
                aria-selected={activeHomeTab === 'recent'}
                type="button"
                onClick={() => {
                  startTransition(() => {
                    setActiveHomeTab('recent');
                  });
                }}
              >
                最近
              </button>
              <button
                className={`tdocs-tab ${activeHomeTab === 'my-docs' ? 'tdocs-tab--active' : ''}`}
                role="tab"
                aria-selected={activeHomeTab === 'my-docs'}
                type="button"
                onClick={() => {
                  startTransition(() => {
                    setActiveHomeTab('my-docs');
                  });
                }}
              >
                我的文档
              </button>
              <button className="tdocs-tab" role="tab" aria-selected={false} type="button">收藏</button>
              <div className="tdocs-tabs__spacer" />
              <button className="tdocs-tabs__action" type="button">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                显示
              </button>
              <button className="tdocs-tabs__action" type="button">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M1 4h12M1 7h8M1 10h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                筛选
              </button>
            </div>

            {/* Table */}
            <HomeStateSurface
              connection={connection}
              isLoading={workspace.isLoading}
              error={workspace.error}
              hasWorkbooks={workbooks.length > 0}
              onCreateFirst={() => { void handleCreateWorkbook('legal-entity-tracker'); }}
            />

            {!workspace.isLoading && !workspace.error && activeHomeTab === 'recent' && (
              <div className="tdocs-table-wrap">
                <table className="tdocs-table">
                  <thead>
                    <tr>
                      <th className="tdocs-table__name-col">名称</th>
                      <th>所有者</th>
                      <th>位置</th>
                      <th className="tdocs-table__date-col">
                        最近打开
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{marginLeft: 4}}>
                          <path d="M5 2v6M2 6l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </th>
                      <th>大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWorkbooks.length === 0 && search.trim() ? (
                      <tr>
                        <td colSpan={5} className="tdocs-table__empty">没有匹配「{search}」的文档</td>
                      </tr>
                    ) : null}
                    {filteredWorkbooks.map((workbook) => {
                      const template = findTemplate(workbook.template_key as TemplateKey | null | undefined);
                      const publishSlug = getPublishSlug(workbook.template_key as TemplateKey | null | undefined);
                      return (
                        <tr key={workbook.id} className="tdocs-table__row">
                          <td className="tdocs-table__name-cell">
                            <span className="tdocs-file-icon tdocs-file-icon--sheet" aria-hidden="true">
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <rect x="1" y="1" width="14" height="14" rx="2" fill="#1E6E3A" />
                                <path d="M4 5h8M4 8h8M4 11h5" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
                              </svg>
                            </span>
                            <button className="tdocs-table__name-btn" type="button" onClick={() => onSelectWorkbook(workbook.id)}>
                              {workbook.name}
                            </button>
                            <div className="tdocs-table__row-actions">
                              {publishSlug && workspaceId ? (
                                <button
                                  className="tdocs-row-action"
                                  type="button"
                                  title="发布表单"
                                  onClick={() => onOpenPublishedForm(workspaceId, publishSlug)}
                                >
                                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                    <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M2 10v2h10v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : null}
                              <button className="tdocs-row-action" type="button" title="更多操作">
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <circle cx="3" cy="7" r="1.2" fill="currentColor" />
                                  <circle cx="7" cy="7" r="1.2" fill="currentColor" />
                                  <circle cx="11" cy="7" r="1.2" fill="currentColor" />
                                </svg>
                              </button>
                            </div>
                          </td>
                          <td className="tdocs-table__meta">我</td>
                          <td className="tdocs-table__meta">{workspaceName}</td>
                          <td className="tdocs-table__meta">{formatUpdatedAt(workbook.updated_at) || '刚创建'}</td>
                          <td className="tdocs-table__meta">
                            <span className="tdocs-template-tag">{template?.name ?? '工作簿'}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {!workspace.isLoading && !workspace.error && filteredWorkbooks.length > 0 && (
                  <div className="tdocs-create-row">
                    {templateCatalog.map((template) => (
                      <button
                        key={template.key}
                        className="tdocs-create-chip"
                        type="button"
                        disabled={isCreating !== null}
                        onClick={() => { void handleCreateWorkbook(template.key); }}
                      >
                        {isCreating === template.key ? '创建中…' : `+ ${template.name}`}
                      </button>
                    ))}
                    {createError ? <p className="intake-form__error" role="alert">{createError}</p> : null}
                  </div>
                )}
              </div>
            )}

            {!workspace.isLoading && !workspace.error && activeHomeTab === 'my-docs' && workspaceId ? (
              <FolderContentsPane
                db={db}
                workspaceId={workspaceId}
                selectedFolderId={selectedFolderId}
                displayName="我"
                onOpenWorkbook={onSelectWorkbook}
                onFolderSelect={setSelectedFolderId}
              />
            ) : null}

            {showTemplateGallery && (
              <section className="tdocs-template-gallery" aria-label="模板库">
                <p className="tdocs-gallery-label">模板库</p>
                <div className="tdocs-template-grid">
                  {templateCatalog.map((template) => (
                    <article key={template.key} className="tdocs-template-card">
                      <p className="tdocs-template-card__category">{template.category}</p>
                      <h3>{template.name}</h3>
                      <p className="tdocs-template-card__copy">{template.description}</p>
                      <button
                        className="tdocs-template-card__use"
                        type="button"
                        disabled={isCreating !== null}
                        onClick={() => { void handleCreateWorkbook(template.key); }}
                      >
                        {isCreating === template.key ? '创建中…' : '使用此模板'}
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function EditorChrome({
  db,
  displayName,
  workspaceId,
  wsKey,
  workspaceName,
  workbooks,
  activeWorkbook,
  activeWorkbookId,
  activePanel,
  activeTemplate,
  isWorkspaceLoading,
  workspaceError,
  connection,
  onSelectWorkbook,
  onSelectPanel,
  onShowHome,
  onShowAdmin,
  onOpenPublishedForm,
  onLogout,
}: {
  db: Surreal;
  displayName?: string;
  workspaceId: string | null;
  wsKey: string | null;
  workspaceName: string;
  workbooks: Array<{ id: string; name: string; template_key: string | null; updated_at?: string | null }>;
  activeWorkbook: { id: string; name: string; template_key: string | null } | null;
  activeWorkbookId?: string;
  activePanel: SidebarPanel;
  activeTemplate: ReturnType<typeof findTemplate>;
  isWorkspaceLoading: boolean;
  workspaceError: string | null;
  connection: ConnectionSnapshot;
  onSelectWorkbook: (id: string) => void;
  onSelectPanel: (panel: SidebarPanel) => void;
  onShowHome: () => void;
  onShowAdmin: () => void;
  onOpenPublishedForm: (workspaceId: string, formSlug: string) => void;
  onLogout?: () => void;
}) {
  const { sheets, createSheet, error: sheetsError } = useSheets(db, activeWorkbook?.id ?? null, wsKey);
  const publishSlug = getPublishSlug(activeWorkbook?.template_key as TemplateKey | null | undefined);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(activeWorkbook?.name ?? '');

  // Sync title when workbook changes
  if (!editingTitle && titleValue !== (activeWorkbook?.name ?? '')) {
    setTitleValue(activeWorkbook?.name ?? '');
  }

  const autosaveLabel = connection.state === 'reconnecting'
    ? '重连中…'
    : connection.state === 'disconnected'
      ? '连接中断'
      : '已自动保存到云端';

  return (
    <div className="editor-shell">
      {/* Tencent Docs-style top bar */}
      <header className="ck-editor-topbar">
        <div className="ck-editor-topbar__left">
          {/* Logo */}
          <button className="ck-editor-topbar__logo-btn" type="button" aria-label="返回文档列表" onClick={onShowHome}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect width="8.5" height="8.5" rx="2" fill="#2F6BFF" />
              <rect x="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.6" />
              <rect y="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.6" />
              <rect x="11.5" y="11.5" width="8.5" height="8.5" rx="2" fill="#2F6BFF" opacity="0.3" />
            </svg>
          </button>

          {/* Workbook switcher */}
          <div className="ck-editor-topbar__switcher">
            <button
              className="ck-editor-topbar__switcher-btn"
              type="button"
              aria-label="切换工作簿"
              aria-expanded={switcherOpen}
              onClick={() => setSwitcherOpen((v) => !v)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="1" y="2" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="6.25" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="10.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
              </svg>
            </button>
            {switcherOpen && (
              <div className="ck-header-dropdown">
                {workbooks.map((wb) => (
                  <button
                    key={wb.id}
                    className={`ck-header-dropdown__item ${wb.id === activeWorkbookId ? 'ck-header-dropdown__item--active' : ''}`}
                    type="button"
                    onClick={() => { onSelectWorkbook(wb.id); setSwitcherOpen(false); }}
                  >
                    {wb.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Editable doc title */}
          {editingTitle ? (
            <input
              className="ck-header-title-input"
              value={titleValue}
              autoFocus
              aria-label="工作簿名称"
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur(); }}
            />
          ) : (
            <button
              className="ck-header-title"
              type="button"
              aria-label={`工作簿：${titleValue || '未命名'}`}
              onClick={() => setEditingTitle(true)}
            >
              {titleValue || <span className="ck-header-title__placeholder">未命名</span>}
            </button>
          )}

          {/* Autosave chip */}
          <span className="ck-editor-autosave" data-state={connection.state} aria-live="polite">
            {autosaveLabel}
          </span>
        </div>

        <div className="ck-editor-topbar__right">
          {/* Publish form action */}
          {publishSlug && workspaceId ? (
            <button
              className="ck-editor-topbar__action-btn"
              type="button"
              title="发布申报表单"
              onClick={() => onOpenPublishedForm(workspaceId, publishSlug)}
            >
              发布
            </button>
          ) : null}

          {/* Panel toggle — opens/closes the right dock */}
          <button
            className={`ck-editor-topbar__icon-btn ${activePanel !== 'none' ? 'ck-editor-topbar__icon-btn--active' : ''}`}
            type="button"
            title={activePanel !== 'none' ? '收起面板' : '展开工具面板'}
            aria-label={activePanel !== 'none' ? '收起面板' : '展开工具面板'}
            onClick={() => onSelectPanel(activePanel !== 'none' ? 'none' : 'record')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10 2v12" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>

          {/* Share / copy link */}
          <button
            className="ck-header-btn ck-header-btn--share"
            type="button"
            title="复制链接"
            onClick={() => { void navigator.clipboard.writeText(window.location.href).catch(() => undefined); }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ marginRight: 4 }}>
              <circle cx="10.5" cy="2" r="1.6" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="2.5" cy="6.5" r="1.6" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="10.5" cy="11" r="1.6" stroke="currentColor" strokeWidth="1.2" />
              <line x1="4" y1="5.7" x2="9" y2="2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="4" y1="7.3" x2="9" y2="10.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            分享
          </button>

          {/* Avatar / logout */}
          {displayName ? (
            <button
              className="ck-header-avatar"
              type="button"
              title={onLogout ? `${displayName} — 点击退出` : displayName}
              aria-label={displayName}
              onClick={onLogout ?? undefined}
            >
              {displayName.slice(0, 1).toUpperCase()}
            </button>
          ) : null}
        </div>
      </header>

      <div className="editor-shell__body">
        <main className="editor-shell__canvas" aria-label="Workbook editor">
          <EditorStateSurface
            isWorkspaceLoading={isWorkspaceLoading}
            workspaceError={workspaceError}
            sheetsError={sheetsError}
            activeWorkbook={activeWorkbook}
            onShowHome={onShowHome}
          />
          {!isWorkspaceLoading && !workspaceError && !sheetsError && activeWorkbook && workspaceId && (
            <UniverGrid
              db={db}
              workbookId={activeWorkbook.id}
              workspaceId={workspaceId}
              wsKey={wsKey}
              sheets={sheets}
              createSheet={createSheet}
              workbookName={activeWorkbook.name}
              displayName={displayName}
              workbooks={workbooks}
              activeWorkbookId={activeWorkbookId}
              onSelectWorkbook={onSelectWorkbook}
              onSelectPanel={onSelectPanel}
              onShowAdmin={onShowAdmin}
              onLogout={onLogout}
            />
          )}
        </main>

        {activePanel !== 'none' && activeWorkbook && (
          <aside className="workbook-drawer" aria-label={panelLabels[activePanel]}>
            <div className="workbook-drawer__header">
              <div>
                <p className="eyebrow">{workspaceName}</p>
                <h2>{panelLabels[activePanel]}</h2>
              </div>
              <button className="ghost-button ghost-button--icon" type="button" onClick={() => onSelectPanel('none')}>
                ×
              </button>
            </div>
            <div className="workbook-drawer__body">
              <SidebarPanelContent
                db={db}
                workspaceId={workspaceId}
                wsKey={wsKey}
                activePanel={activePanel}
                workbookId={activeWorkbook.id}
                workbookName={activeWorkbook.name}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ConnectionBanner({ connection }: { connection: ConnectionSnapshot }) {
  if (connection.state !== 'reconnecting' && connection.state !== 'disconnected') {
    return null;
  }

  return (
    <div className="reconnect-banner" role="status" aria-live="polite">
      <span className="reconnect-banner__dot" aria-hidden="true" />
      {connection.state === 'reconnecting' ? '正在重新连接工作区…' : '连接已中断，页面已切换到受控离线提示状态'}
    </div>
  );
}

function HomeStateSurface({
  connection,
  isLoading,
  error,
  hasWorkbooks,
  onCreateFirst,
}: {
  connection: ConnectionSnapshot;
  isLoading: boolean;
  error: string | null;
  hasWorkbooks: boolean;
  onCreateFirst: () => void;
}) {
  if (isLoading) {
    return <div className="state-card"><p>正在加载工作区和最近文档…</p></div>;
  }

  if (connection.state === 'auth-failed') {
    return <div className="state-card state-card--warning"><p>登录状态失效。请重新进入文档主页后恢复会话。</p></div>;
  }

  if (error) {
    return (
      <div className="state-card state-card--warning">
        <p>{classifyWorkspaceError(error)}</p>
      </div>
    );
  }

  if (!hasWorkbooks) {
    return (
      <div className="state-card">
        <p>当前工作区还没有任何工作簿，但首页骨架和操作入口已准备好。</p>
        <button className="primary-button" type="button" onClick={onCreateFirst}>
          创建第一份债权申报总表
        </button>
      </div>
    );
  }

  return null;
}

function EditorStateSurface({
  isWorkspaceLoading,
  workspaceError,
  sheetsError,
  activeWorkbook,
  onShowHome,
}: {
  isWorkspaceLoading: boolean;
  workspaceError: string | null;
  sheetsError: string | null;
  activeWorkbook: { id: string; name: string } | null;
  onShowHome: () => void;
}) {
  if (isWorkspaceLoading) {
    return <div className="state-card state-card--floating"><p>正在打开工作簿…</p></div>;
  }

  if (workspaceError) {
    return (
      <div className="state-card state-card--floating state-card--warning">
        <p>{classifyWorkspaceError(workspaceError)}</p>
        <button className="secondary-button" type="button" onClick={onShowHome}>
          返回首页
        </button>
      </div>
    );
  }

  if (!activeWorkbook) {
    return (
      <div className="state-card state-card--floating state-card--warning">
        <p>该工作簿已被删除或当前账号无权访问，请返回首页重新选择。</p>
        <button className="secondary-button" type="button" onClick={onShowHome}>
          返回首页
        </button>
      </div>
    );
  }

  if (sheetsError) {
    return (
      <div className="state-card state-card--floating state-card--warning">
        <p>工作表加载不完整：{sheetsError}</p>
      </div>
    );
  }

  return null;
}

function classifyWorkspaceError(error: string): string {
  const message = error.toLowerCase();

  if (message.includes('permission') || message.includes('forbidden')) {
    return '你当前没有访问这个工作区的权限，请联系债权协作空间管理员。';
  }

  if (message.includes('no workspace')) {
    return '当前账号还未加入任何工作区，请先创建或接受工作区邀请。';
  }

  return `工作区暂时不可用：${error}`;
}

function UniverGrid({
  db,
  workbookId,
  workspaceId,
  wsKey,
  sheets,
  createSheet,
  workbookName,
  displayName,
  workbooks,
  activeWorkbookId,
  onSelectWorkbook,
  onSelectPanel,
  onShowAdmin,
  onLogout,
}: {
  db: Surreal;
  workbookId: string;
  workspaceId: string;
  wsKey: string | null;
  sheets: Sheet[];
  createSheet: (opts: CreateSheetOpts) => Promise<Sheet>;
  workbookName: string;
  displayName?: string;
  workbooks: Array<{ id: string; name: string; updated_at?: string | null }>;
  activeWorkbookId?: string;
  onSelectWorkbook: (id: string) => void;
  onSelectPanel?: (panel: SidebarPanel) => void;
  onShowAdmin?: () => void;
  onLogout?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const sheetsRef = useRef<Sheet[]>(sheets);

  useEffect(() => {
    sheetsRef.current = sheets;
  }, [sheets]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let instance: UniverInstance | null = null;
    let cancelled = false;

    setStatus('loading');
    setErrorMsg(null);

    bootstrapUniver({
      db,
      workbookId,
      workspaceId,
      clientId,
      container: containerRef.current,
      sheets: sheets.length > 0 ? sheets : undefined,
      wsKey: wsKey ?? undefined,
      getSheets: () => sheetsRef.current,
      workbookName,
      displayName,
      workbooks,
      activeWorkbookId,
      onSelectWorkbook,
      onSelectPanel,
      onShowAdmin,
      onLogout,
      onSheetAdded: async (univerId, label) => {
        try {
          await createSheet({ label, univerId });
        } catch {
          // Non-fatal: the sheet tab can exist in Univer before the database catches up.
        }
      },
    })
      .then((nextInstance) => {
        if (cancelled) {
          nextInstance.destroy();
          return;
        }
        instance = nextInstance;
        setStatus('ready');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setStatus('error');
        setErrorMsg(error instanceof Error ? error.message : 'Failed to load spreadsheet');
      });

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [activeWorkbookId, createSheet, db, displayName, onLogout, onSelectPanel, onSelectWorkbook, onShowAdmin, sheets, workbookId, workbookName, workspaceId, workbooks, wsKey]);

  return (
    <div className="univer-container" aria-label="Spreadsheet">
      {status === 'loading' ? <p className="editor-shell__hint">正在载入表格画布…</p> : null}
      {status === 'error' ? <p className="intake-form__error">{errorMsg ?? '表格加载失败。'}</p> : null}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

function SidebarPanelContent({
  db,
  workspaceId,
  wsKey,
  activePanel,
  workbookId,
  workbookName,
}: {
  db: Surreal;
  workspaceId: string | null;
  wsKey: string | null;
  activePanel: SidebarPanel;
  workbookId: string;
  workbookName: string;
}) {
  if (activePanel === 'record') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Claim detail</p>
        <h2>债权详情卡片</h2>
        <p className="sidebar-copy">保持表格主视图不变，把单条债权、申报材料和备注集中放在这里查看。</p>
      </div>
    );
  }

  if (activePanel === 'graph') {
    return (
      <GraphResultsPanel
        result={{
          cellLabel: workbookName,
          items: [
            { label: workbookName, recordId: workbookId, entityType: 'Workbook' },
          ],
        }}
      />
    );
  }

  if (activePanel === 'history') {
    return <RecentChangesPanel db={db} workbookId={workbookId} />;
  }

  if (activePanel === 'review') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Review queue</p>
        <h2>申报复核</h2>
        <p className="sidebar-copy">MVP 先保留位置和层级，后续会在这里承接核验、驳回、补正与分配流程。</p>
      </div>
    );
  }

  if (activePanel === 'ai') {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">AI assistant</p>
        <h2>受控智能辅助</h2>
        <p className="sidebar-copy">AI 能力在本期只作为明确的未来入口出现，不会干扰当前债权协作主路径。</p>
      </div>
    );
  }

  if (activePanel === 'admin' && workspaceId && wsKey) {
    return <AdminSidebar db={db} workspaceId={workspaceId} workbookId={workbookId} wsKey={wsKey} isAdmin={true} />;
  }

  return null;
}

function formatConnectionLabel(state: ConnectionSnapshot['state']) {
  switch (state) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'reconnecting': return '重连中';
    case 'auth-failed': return '登录失效';
    case 'error': return '连接异常';
    case 'disconnected': return '离线';
    default: return '待连接';
  }
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
    <main className="auth-screen">
      <section className="state-card state-card--auth" aria-label="Authentication">
        <p className="eyebrow">Authentication</p>
        <h1>{title}</h1>
        <p className="sidebar-copy">{body}</p>
        {error ? <p className="intake-form__error">最近一次错误：{error}</p> : null}
        {actionLabel && onAction ? (
          <button className="primary-button" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}
