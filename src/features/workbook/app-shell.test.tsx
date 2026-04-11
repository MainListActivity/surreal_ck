import { fireEvent, render, screen } from '@testing-library/react';
import { Surreal } from 'surrealdb';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionSnapshot } from '../../lib/surreal/types';
import { AppShell } from './app-shell';

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
      data: {
        id: 'workspace:harbor',
        name: 'Harbor Legal Ops',
        memberCount: 4,
        workbooks: [
          { id: 'workbook:claims', name: '债权申报总表', template_key: 'legal-entity-tracker', updated_at: null },
          { id: 'workbook:cases', name: '案件台账', template_key: 'case-management', updated_at: null },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

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

    expect(screen.getByRole('heading', { name: 'Harbor Legal Ops' })).toBeInTheDocument();
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

    fireEvent.click(screen.getAllByRole('button', { name: '债权申报总表' })[1]);

    expect(props.onSelectWorkbook).toHaveBeenCalledWith('workbook:claims');
  });

  it('opens the published form from the home list', () => {
    const { props } = renderApp();

    fireEvent.click(screen.getAllByRole('button', { name: '发布表单' })[0]);

    expect(props.onOpenPublishedForm).toHaveBeenCalledWith('workspace:harbor', 'new-client-intake');
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
