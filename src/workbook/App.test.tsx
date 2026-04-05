import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App';

// ─── Module mocks ────────────────────────────────────────────────────────────

import type { AuthSnapshot, ConnectionSnapshot } from '../surreal/types';

const mockUseAuthSnapshot = vi.fn((): AuthSnapshot => ({
  status: 'authenticated',
  isLoggedIn: true,
  user: { sub: 'test-user', email: 'test@example.com', name: 'Test User', recordId: 'app_user:test-user' },
  updatedAt: Date.now(),
}));

const mockUseConnectionSnapshot = vi.fn((): ConnectionSnapshot => ({
  state: 'connected',
  updatedAt: Date.now(),
}));

vi.mock('../surreal/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../surreal/auth')>();
  return {
    ...original,
    useAuthSnapshot: () => mockUseAuthSnapshot(),
    authGateway: { startLogin: vi.fn(), logout: vi.fn() },
  };
});

vi.mock('../surreal/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../surreal/client')>();
  return {
    ...original,
    useConnectionSnapshot: () => mockUseConnectionSnapshot(),
  };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('App shell', () => {
  it('shows the template picker when there is no workbook to resume', () => {
    render(<App initialScenario="template-picker" />);

    expect(screen.getByRole('heading', { name: 'Start in a workbook, not a dashboard.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Legal Entity Tracker' })).toBeInTheDocument();
  });

  it('opens the workbook shell by default for resume flow', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Harbor Legal Ops' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Workbook preview grid' })).toBeInTheDocument();
  });

  it('routes blank workspace selections into guided setup', () => {
    render(<App initialScenario="template-picker" />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Blank Workspace' }));

    expect(screen.getByRole('heading', { name: 'Exactly three first actions' })).toBeInTheDocument();
    expect(screen.getByText('Create the first entity type')).toBeInTheDocument();
  });
});

describe('App shell — auth states', () => {
  it('shows authorizing screen while auth is checking', () => {
    mockUseAuthSnapshot.mockReturnValueOnce({
      status: 'checking',
      isLoggedIn: false,
      updatedAt: Date.now(),
    });

    render(<App />);
    expect(screen.getByText(/Authorizing workspace/i)).toBeInTheDocument();
  });

  it('shows sign-in screen when user is not logged in', () => {
    mockUseAuthSnapshot.mockReturnValueOnce({
      status: 'unauthenticated',
      isLoggedIn: false,
      updatedAt: Date.now(),
    });

    render(<App />);
    expect(screen.getByRole('button', { name: /Continue with MapLayer/i })).toBeInTheDocument();
  });
});

describe('App shell — reconnect banner', () => {
  it('shows reconnect banner when connection is reconnecting', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'reconnecting', updatedAt: Date.now() });

    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent(/Reconnecting/i);
  });

  it('shows offline banner when disconnected', () => {
    mockUseConnectionSnapshot.mockReturnValueOnce({ state: 'disconnected', updatedAt: Date.now() });

    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent(/Connection lost/i);
  });

  it('hides reconnect banner when connected', () => {
    render(<App />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
