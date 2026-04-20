import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SheetSummary } from './entity-types';
import { EntityTypesPanel } from './entity-types';
import type { WorkspaceMember } from './workspace-members';
import { WorkspaceMembersPanel } from './workspace-members';
import { AdminSidebar } from './admin-sidebar';
import type { DbAdapter } from '../lib/surreal/db-adapter';

// ─── Mock DB factory ──────────────────────────────────────────────────────────

function createMockDb(overrides: Partial<{ query: ReturnType<typeof vi.fn> }> = {}) {
  return {
    query: overrides.query ?? vi.fn(async () => [[]] as any),
  } as unknown as DbAdapter;
}

const WS_ID = 'workspace:test';
const WB_ID = 'workbook:test';
const WS_KEY = 'test';

// ─── AdminSidebar — permission gate ──────────────────────────────────────────

describe('AdminSidebar — permission gate', () => {
  it('renders nothing when user is not admin', () => {
    const db = createMockDb();
    const { container } = render(<AdminSidebar db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} isAdmin={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders admin content when user is admin', () => {
    const db = createMockDb();
    render(<AdminSidebar db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} isAdmin={true} />);
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeInTheDocument();
  });
});

// ─── EntityTypesPanel ─────────────────────────────────────────────────────────

describe('EntityTypesPanel', () => {
  it('loads and displays entity types from DB', async () => {
    const items: SheetSummary[] = [
      { id: 'sheet:1', label: 'Company', table_name: 'ent_test_company', column_defs: [] },
      { id: 'sheet:2', label: 'Person', table_name: 'ent_test_person', column_defs: [] },
    ];
    const db = createMockDb({ query: vi.fn(async () => [items] as any) });

    render(<EntityTypesPanel db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} />);

    await waitFor(() => {
      expect(screen.getByText('Company')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
    });
  });

  it('shows empty state when no entity types exist', async () => {
    const db = createMockDb({ query: vi.fn(async () => [[]] as any) });
    render(<EntityTypesPanel db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} />);

    await waitFor(() => {
      expect(screen.getByText(/No entity types yet/)).toBeInTheDocument();
    });
  });

  it('shows validation error when generated table key is too long', async () => {
    const db = createMockDb({ query: vi.fn(async () => [[]] as any) });
    render(<EntityTypesPanel db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} />);
    await waitFor(() => screen.getByText(/No entity types yet/));

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const input = screen.getByLabelText('Entity type name');
    fireEvent.change(input, { target: { value: 'A'.repeat(80) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Table key must start/i);
    });
    // DB should not have been called for DDL
    expect(db.query).toHaveBeenCalledTimes(1); // only the initial load
  });

  it('creates entity type successfully and updates list', async () => {
    const newItem: SheetSummary = { id: 'sheet:new', label: 'Investor', table_name: 'ent_test_investor', column_defs: [] };

    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]] as any)             // initial load
      .mockResolvedValueOnce([undefined] as any)      // DDL DEFINE TABLE (no return)
      .mockResolvedValueOnce([[newItem]] as any);     // INSERT entity_type

    const db = createMockDb({ query: queryMock });
    render(<EntityTypesPanel db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} />);
    await waitFor(() => screen.getByText(/No entity types yet/));

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const input = screen.getByLabelText('Entity type name');
    fireEvent.change(input, { target: { value: 'Investor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Investor')).toBeInTheDocument();
    });
  });

  it('shows DDL verify error when INFO FOR DB does not include new table', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]] as any)         // initial load
      .mockRejectedValueOnce(new Error('DDL failed'));

    const db = createMockDb({ query: queryMock });
    render(<EntityTypesPanel db={db} workspaceId={WS_ID} workbookId={WB_ID} wsKey={WS_KEY} />);
    await waitFor(() => screen.getByText(/No entity types yet/));

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Entity type name'), { target: { value: 'Orphan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

// ─── WorkspaceMembersPanel ───────────────────────────────────────────────────

describe('WorkspaceMembersPanel', () => {
  it('loads and displays members', async () => {
    const members: WorkspaceMember[] = [
      { id: 'workspace_member:1', email: 'alice@example.com', role: 'admin', invited_at: '2026-04-01' },
    ];
    const db = createMockDb({ query: vi.fn(async () => [members] as any) });
    render(<WorkspaceMembersPanel db={db} workspaceId={WS_ID} />);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });
  });

  it('shows "Already a member" error when inviting duplicate email', async () => {
    const members: WorkspaceMember[] = [
      { id: 'workspace_member:1', email: 'alice@example.com', role: 'editor', invited_at: '2026-04-01' },
    ];
    const db = createMockDb({ query: vi.fn(async () => [members] as any) });
    render(<WorkspaceMembersPanel db={db} workspaceId={WS_ID} />);
    await waitFor(() => screen.getByText('alice@example.com'));

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Already a member/);
    });
    // DB insert should NOT have been called (client-side check caught it first)
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('invites a new member and adds to list', async () => {
    const newMember: WorkspaceMember = {
      id: 'workspace_member:2',
      email: 'bob@example.com',
      role: 'editor',
      invited_at: '2026-04-05',
    };
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]] as any)          // initial load
      .mockResolvedValueOnce([[newMember]] as any); // INSERT

    const db = createMockDb({ query: queryMock });
    render(<WorkspaceMembersPanel db={db} workspaceId={WS_ID} />);
    await waitFor(() => screen.getByText(/No members yet/));

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'bob@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    await waitFor(() => {
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    });
  });
});
