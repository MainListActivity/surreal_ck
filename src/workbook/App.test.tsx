import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App';

// Provide an authenticated stub so App renders the workbook shell in tests
vi.mock('../surreal/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../surreal/auth')>();
  return {
    ...original,
    useAuthSnapshot: () => ({
      status: 'authenticated',
      isLoggedIn: true,
      user: { sub: 'test-user', email: 'test@example.com', name: 'Test User', recordId: 'app_user:test-user' },
      updatedAt: Date.now(),
    }),
    authGateway: {
      startLogin: vi.fn(),
      logout: vi.fn(),
    },
  };
});

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
