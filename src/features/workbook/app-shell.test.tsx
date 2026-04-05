import { fireEvent, render, screen } from '@testing-library/react';
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

function renderApp(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const props: Parameters<typeof AppShell>[0] = {
    view: 'workbook',
    activeWorkbookId: 'wb-legal-entities',
    activePanel: 'graph',
    displayName: 'Test User',
    onSelectTemplate: vi.fn(),
    onSelectWorkbook: vi.fn(),
    onSelectPanel: vi.fn(),
    onShowTemplates: vi.fn(),
    onShowAdmin: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };

  return {
    ...render(<AppShell {...props} />),
    props,
  };
}

describe('App shell', () => {
  it('shows the template picker in template mode', () => {
    renderApp({ view: 'template-picker' });

    expect(screen.getByRole('heading', { name: 'Start in a workbook, not a dashboard.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Legal Entity Tracker' })).toBeInTheDocument();
  });

  it('opens the workbook shell by default for workbook mode', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Harbor Legal Ops' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Workbook preview grid' })).toBeInTheDocument();
  });

  it('routes template selections through the callback prop', () => {
    const { props } = renderApp({ view: 'template-picker' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Blank Workspace' }));

    expect(props.onSelectTemplate).toHaveBeenCalledWith('blank-workspace');
  });

  it('opens the record panel through the callback prop', () => {
    const { props } = renderApp();

    fireEvent.click(screen.getAllByRole('button', { name: 'Record detail' })[0]);

    expect(props.onSelectPanel).toHaveBeenCalledWith('record');
  });
});

describe('App shell — reconnect banner', () => {
  it('shows reconnect banner when connection is reconnecting', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'reconnecting', updatedAt: Date.now() });

    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/Reconnecting/i);
  });

  it('shows offline banner when disconnected', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'disconnected', updatedAt: Date.now() });

    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent(/Connection lost/i);
  });

  it('hides reconnect banner when connected', () => {
    renderApp();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
