import { describe, expect, it, vi } from 'vitest';

import { restoreSession, signIn, signOut } from './auth';
import { connectionState, connectToSurreal } from './client';

const createFakeClient = () => {
  return {
    connect: vi.fn(async () => true),
    signIn: vi.fn(async () => ({ access: 'access-token', refresh: 'refresh-token' })),
    restoreSession: vi.fn(
      async (): Promise<{ access: string; refresh: string } | null> => ({
        access: 'renewed-access',
        refresh: 'renewed-refresh',
      }),
    ),
    signOut: vi.fn(async () => true as const),
    close: vi.fn(async () => true as const),
    getConnectionSnapshot: vi.fn(async () => ({
      state: 'idle' as const,
      updatedAt: Date.now(),
    })),
  };
};

describe('surreal auth and connection', () => {
  it('routes sign-in through the worker client', async () => {
    const client = createFakeClient();

    const tokens = await signIn('lawyer@example.com', 'secret', client);

    expect(tokens.access).toBe('access-token');
    expect(client.signIn).toHaveBeenCalledWith('lawyer@example.com', 'secret');
  });

  it('restores a saved worker session', async () => {
    const client = createFakeClient();

    const refreshed = await restoreSession(client);

    expect(client.restoreSession).toHaveBeenCalled();
    expect(refreshed).toEqual({
      access: 'renewed-access',
      refresh: 'renewed-refresh',
    });
  });

  it('returns null when worker session restore fails safe', async () => {
    const client = createFakeClient();
    client.restoreSession.mockResolvedValueOnce(null);

    const restored = await restoreSession(client);

    expect(restored).toBeNull();
  });

  it('routes sign-out through the worker client', async () => {
    const client = createFakeClient();

    await signOut(client);

    expect(client.signOut).toHaveBeenCalled();
  });

  it('connects through the worker client', async () => {
    const client = createFakeClient();

    await connectToSurreal(client);

    expect(client.connect).toHaveBeenCalled();
  });

  it('allows connection snapshots to be observed', () => {
    const seen: Array<string | undefined> = [];
    const unsubscribe = connectionState.subscribe((snapshot) => {
      seen.push(snapshot.state);
    });

    connectionState.set('reconnecting');
    connectionState.set('connected', 'worker');

    unsubscribe();

    expect(seen).toContain('reconnecting');
    expect(seen).toContain('connected');
  });
});
