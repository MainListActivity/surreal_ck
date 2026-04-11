import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { Surreal } from 'surrealdb';

import { AdminSidebar } from '../../admin/admin-sidebar';
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
        <ConnectionBanner connection={connection} />
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
          onSelectWorkbook={onSelectWorkbook}
          onSelectPanel={onSelectPanel}
          onShowHome={onShowHome}
          onShowAdmin={onShowAdmin}
          onOpenPublishedForm={onOpenPublishedForm}
          onLogout={onLogout}
          isOffline={isOffline}
        />
      </div>
    );
  }

  return (
    <div className="ck-page ck-page--home">
      <ConnectionBanner connection={connection} />
      <section className="docs-home" aria-label="Tencent compatible workbook home">
        <aside className="docs-home__rail" aria-label="Workspace navigation">
          <div className="docs-home__brand">
            <p className="eyebrow">债权协作</p>
            <h1>文档</h1>
            <p className="sidebar-copy">保持腾讯文档式入口节奏，强化受控与留痕。</p>
          </div>

          <nav className="docs-home__nav">
            <button className="rail-button rail-button--active" type="button" onClick={onShowHome}>
              最近打开
            </button>
            <button className="rail-button" type="button" onClick={onShowTemplates}>
              快速新建
            </button>
            <button className="rail-button" type="button" onClick={onShowAdmin}>
              工作区设置
            </button>
          </nav>

          <div className="docs-home__trust">
            <span className="status-chip">{formatConnectionLabel(connection.state)}</span>
            <p className="sidebar-copy">敏感工作区。所有债权申报、补正和复核动作均留在受控协作空间内。</p>
          </div>
        </aside>

        <main className="docs-home__main">
          <header className="docs-home__header">
            <div>
              <p className="eyebrow">Sensitive workspace</p>
              <h2>{workspaceName}</h2>
            </div>
            <div className="docs-home__header-actions">
              <label className="docs-search">
                <span className="sr-only">搜索工作簿</span>
                <input
                  aria-label="Search workbooks"
                  placeholder="搜索工作簿、台账或模板"
                  type="search"
                  value={search}
                  onChange={(event) => {
                    startTransition(() => {
                      setSearch(event.target.value);
                    });
                  }}
                />
              </label>
              {displayName ? <span className="docs-home__user">{displayName}</span> : null}
            </div>
          </header>

          <section className="docs-home__create" aria-label="Quick create">
            <div>
              <p className="eyebrow">Quick create</p>
              <h3>从熟悉的表格入口开始</h3>
            </div>
            <div className="docs-home__create-actions">
              {templateCatalog.map((template) => (
                <button
                  key={template.key}
                  className={`secondary-button docs-home__create-button ${showTemplateGallery ? 'docs-home__create-button--featured' : ''}`}
                  type="button"
                  disabled={isCreating !== null}
                  onClick={() => { void handleCreateWorkbook(template.key); }}
                >
                  {isCreating === template.key ? '创建中…' : template.name}
                </button>
              ))}
            </div>
            {createError ? <p className="intake-form__error" role="alert">{createError}</p> : null}
          </section>

          {showTemplateGallery && (
            <section className="docs-home__templates" aria-label="Template gallery">
              {templateCatalog.map((template) => (
                <article key={template.key} className="template-card">
                  <p className="eyebrow">{template.category}</p>
                  <h3>{template.name}</h3>
                  <p className="template-card__copy">{template.description}</p>
                  <dl className="template-card__facts">
                    <div>
                      <dt>起始表</dt>
                      <dd>{template.starterSheets}</dd>
                    </div>
                    <div>
                      <dt>发布入口</dt>
                      <dd>{template.publishLabel}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </section>
          )}

          <section className="docs-home__list-section" aria-label="Recent workbooks">
            <div className="docs-home__list-header">
              <div>
                <p className="eyebrow">Recent workbooks</p>
                <h3>最近使用</h3>
              </div>
              <span className="sidebar-copy">{workbooks.length} 个工作簿</span>
            </div>

            <HomeStateSurface
              connection={connection}
              isLoading={workspace.isLoading}
              error={workspace.error}
              hasWorkbooks={workbooks.length > 0}
              onCreateFirst={() => { void handleCreateWorkbook('legal-entity-tracker'); }}
            />

            {!workspace.isLoading && !workspace.error && filteredWorkbooks.length > 0 && (
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>工作簿</th>
                    <th>模板</th>
                    <th>更新时间</th>
                    <th>动作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredWorkbooks.map((workbook) => (
                    <tr key={workbook.id}>
                      <td>
                        <button className="docs-table__link" type="button" onClick={() => onSelectWorkbook(workbook.id)}>
                          {workbook.name}
                        </button>
                      </td>
                      <td>{findTemplate(workbook.template_key as TemplateKey | null | undefined)?.name ?? '自定义工作簿'}</td>
                      <td>{formatUpdatedAt(workbook.updated_at) || '刚创建'}</td>
                      <td>
                        <div className="docs-table__actions">
                          <button className="ghost-button" type="button" onClick={() => onSelectWorkbook(workbook.id)}>
                            打开
                          </button>
                          {getPublishSlug(workbook.template_key as TemplateKey | null | undefined) ? (
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => {
                                if (workspaceId) {
                                  onOpenPublishedForm(
                                    workspaceId,
                                    getPublishSlug(workbook.template_key as TemplateKey | null | undefined) as string,
                                  );
                                }
                              }}
                            >
                              发布表单
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </main>
      </section>
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
  onSelectWorkbook,
  onSelectPanel,
  onShowHome,
  onShowAdmin,
  onOpenPublishedForm,
  onLogout,
  isOffline,
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
  onSelectWorkbook: (id: string) => void;
  onSelectPanel: (panel: SidebarPanel) => void;
  onShowHome: () => void;
  onShowAdmin: () => void;
  onOpenPublishedForm: (workspaceId: string, formSlug: string) => void;
  onLogout?: () => void;
  isOffline: boolean;
}) {
  const { sheets, createSheet, error: sheetsError } = useSheets(db, activeWorkbook?.id ?? null, wsKey);
  const publishSlug = getPublishSlug(activeWorkbook?.template_key as TemplateKey | null | undefined);

  return (
    <div className="editor-shell">
      <header className="editor-shell__header">
        <div className="editor-shell__title">
          <button className="ghost-button" type="button" onClick={onShowHome}>
            返回文档
          </button>
          <div>
            <p className="eyebrow">债权协作工作簿</p>
            <h1>{activeWorkbook?.name ?? '工作簿'}</h1>
          </div>
        </div>
        <div className="editor-shell__actions">
          <span className="status-chip">{activeTemplate?.name ?? '工作簿'}</span>
          {publishSlug && workspaceId ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => onOpenPublishedForm(workspaceId, publishSlug)}
            >
              发布申报表单
            </button>
          ) : null}
          <button className="secondary-button" type="button" onClick={() => onSelectPanel(activePanel === 'review' ? 'none' : 'review')}>
            复核面板
          </button>
          <button className="ghost-button" type="button" onClick={() => onSelectPanel(activePanel === 'history' ? 'none' : 'history')}>
            最近动态
          </button>
        </div>
      </header>

      <div className="editor-shell__subheader">
        <div className="editor-shell__meta">
          <span className="sidebar-copy">{workspaceName}</span>
          <span className="sidebar-copy">工作表优先，专业能力渐进展开</span>
          {displayName ? <span className="sidebar-copy">当前用户：{displayName}</span> : null}
        </div>
        <div className="editor-shell__dock-tabs" role="tablist" aria-label="Right dock tabs">
          {([
            ['none', '收起'],
            ['record', '债权详情'],
            ['graph', '关联链路'],
            ['history', '动态'],
            ['review', '复核'],
            ['ai', 'AI'],
            ['admin', '管理'],
          ] as Array<[SidebarPanel, string]>).map(([panel, label]) => (
            <button
              key={panel}
              className={`ghost-button ${activePanel === panel ? 'ghost-button--active' : ''}`}
              role="tab"
              type="button"
              aria-selected={activePanel === panel}
              onClick={() => onSelectPanel(activePanel === panel ? 'none' : panel)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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
          {isOffline ? <p className="editor-shell__hint">当前处于重连中，表格仍保持可见，恢复后会继续同步。</p> : null}
        </main>

        {activePanel !== 'none' && activeWorkbook && (
          <aside className="workbook-drawer" aria-label={panelLabels[activePanel]}>
            <div className="workbook-drawer__header">
              <div>
                <p className="eyebrow">Workspace tools</p>
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
