import { fireEvent, render, screen } from '@testing-library/react';
import { Surreal } from 'surrealdb';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionSnapshot } from '../../lib/surreal/types';
import { AppShell } from './app-shell';

const mockDocTreePanel = vi.fn(({ onSelectFolder }: { onSelectFolder: (id: string | null) => void }) => (
  <div>
    <p>DocTreePanel</p>
    <button type="button" onClick={() => onSelectFolder('folder:1')}>选择文件夹</button>
  </div>
));

const mockFolderContentsPane = vi.fn(({ onOpenWorkbook }: { onOpenWorkbook: (id: string) => void }) => (
  <div>
    <p>FolderContentsPane</p>
    <button type="button" onClick={() => onOpenWorkbook('workbook:cases')}>打开树中的工作簿</button>
  </div>
));

const mockUseConnectionSnapshot = vi.fn((): ConnectionSnapshot => ({
  state: 'connected',
  updatedAt: Date.now(),
}));

vi.mock('../../lib/surreal/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/surreal/client')>();
  return {
    ...original,
    useConnectionSnapshot: () => mockUseConnectionSnapshot(),
  };
});

const stubDb = new Surreal();
vi.mock('../../lib/surreal/provider', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/surreal/provider')>();
  return {
    ...original,
    useSurrealClient: () => stubDb,
  };
});

vi.mock('../../shell/template-provisioning', () => ({
  provisionTemplate: vi.fn(async () => ({
    ok: true,
    workspaceId: 'workspace:harbor',
    workbookId: 'workbook:claims',
  })),
}));

vi.mock('../../workbook/univer', () => ({
  bootstrapUniver: vi.fn(async () => ({
    destroy: vi.fn(),
    syncSheets: vi.fn(),
  })),
}));

vi.mock('./use-sheets', () => ({
  useSheets: () => ({
    sheets: [],
    isLoading: false,
    error: null,
    createSheet: vi.fn().mockResolvedValue({}),
    renameSheet: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('./use-workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('./use-workspace')>();
  return {
    ...original,
    useWorkspace: () => ({
      workspaces: [{ id: 'workspace:harbor', name: 'Harbor Legal Ops', memberCount: 4 }],
      workbooks: [
        { id: 'workbook:claims', name: '债权申报总表', template_key: 'legal-entity-tracker', updated_at: null, workspace: 'workspace:harbor' },
        { id: 'workbook:cases', name: '案件台账', template_key: 'case-management', updated_at: null, workspace: 'workspace:harbor' },
      ],
      activeWorkspaceId: 'workspace:harbor',
      activeWorkspace: { id: 'workspace:harbor', name: 'Harbor Legal Ops', memberCount: 4 },
      activeWorkbooks: [
        { id: 'workbook:claims', name: '债权申报总表', template_key: 'legal-entity-tracker', updated_at: null, workspace: 'workspace:harbor' },
        { id: 'workbook:cases', name: '案件台账', template_key: 'case-management', updated_at: null, workspace: 'workspace:harbor' },
      ],
      isLoading: false,
      error: null,
      switchWorkspace: vi.fn(),
    }),
  };
});

vi.mock('../my-docs/doc-tree-panel', () => ({
  DocTreePanel: (props: { onSelectFolder: (id: string | null) => void }) => mockDocTreePanel(props),
}));

vi.mock('../my-docs/folder-contents-pane', () => ({
  FolderContentsPane: (props: { onOpenWorkbook: (id: string) => void }) => mockFolderContentsPane(props),
}));

function renderApp(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const props: Parameters<typeof AppShell>[0] = {
    view: 'home',
    activeWorkbookId: 'workbook:claims',
    activePanel: 'graph',
    displayName: 'Test User',
    ownerUserId: 'app_user:test',
    onSelectWorkbook: vi.fn(),
    onSelectPanel: vi.fn(),
    onShowHome: vi.fn(),
    onShowTemplates: vi.fn(),
    onShowAdmin: vi.fn(),
    onOpenPublishedForm: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };

  return {
    ...render(<AppShell {...props} />),
    props,
  };
}

describe('App shell', () => {
  it('shows the Tencent-compatible home in home mode', () => {
    renderApp();

    expect(screen.getAllByText('Harbor Legal Ops').length).toBeGreaterThan(0);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '债权申报总表' }).length).toBeGreaterThan(0);
  });

  it('shows the editor shell in editor mode', () => {
    renderApp({ view: 'editor', activePanel: 'review' });

    expect(screen.getByRole('main', { name: 'Workbook editor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Spreadsheet')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Review queue' })).toBeInTheDocument();
  });

  it('routes workbook row selections through the callback prop', () => {
    const { props } = renderApp();

    fireEvent.click(screen.getAllByRole('button', { name: '债权申报总表' })[0]);

    expect(props.onSelectWorkbook).toHaveBeenCalledWith('workbook:claims');
  });

  it('opens the published form from the home list', () => {
    const { props } = renderApp();

    fireEvent.click(screen.getAllByRole('button', { name: '发布表单' })[0]);

    expect(props.onOpenPublishedForm).toHaveBeenCalledWith('workspace:harbor', 'new-client-intake');
  });

  it('switches to 我的文档 tab and renders the file tree surface', () => {
    renderApp();

    fireEvent.click(screen.getByRole('tab', { name: '我的文档' }));

    expect(screen.getByText('DocTreePanel')).toBeInTheDocument();
    expect(screen.getByText('FolderContentsPane')).toBeInTheDocument();
  });

  it('opens a workbook from 我的文档 through the callback prop', () => {
    const { props } = renderApp();

    fireEvent.click(screen.getByRole('tab', { name: '我的文档' }));
    fireEvent.click(screen.getByRole('button', { name: '打开树中的工作簿' }));

    expect(props.onSelectWorkbook).toHaveBeenCalledWith('workbook:cases');
  });
});

describe('App shell — reconnect banner', () => {
  it('shows reconnect banner when connection is reconnecting', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'reconnecting', updatedAt: Date.now() });

    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/重新连接/i);
  });

  it('shows offline banner when disconnected', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'disconnected', updatedAt: Date.now() });

    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/连接已中断/i);
  });

  it('hides reconnect banner when connected', () => {
    renderApp();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
