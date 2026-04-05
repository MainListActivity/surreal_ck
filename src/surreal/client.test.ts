import { describe, expect, it, vi } from 'vitest';

import { clearTokens, getTokens, persistTokens, restoreSession, signIn, signOut } from './auth';
import { attachConnectionListeners, connectionState, connectToSurreal } from './client';
import type { SessionStorageLike } from './types';

class MemoryStorage implements SessionStorageLike {
  #store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#store.set(key, value);
  }

  removeItem(key: string): void {
    this.#store.delete(key);
  }
}

const createFakeClient = () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const subscribe = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const current = listeners.get(event) ?? new Set();
    current.add(listener);
    listeners.set(event, current);
    return () => current.delete(listener);
  });

  const emit = (event: string, ...payload: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...payload);
    }
  };

  return {
    connect: vi.fn(async () => true as const),
    signin: vi.fn(async () => ({ access: 'access-token', refresh: 'refresh-token' })),
    authenticate: vi.fn(async () => ({ access: 'renewed-access', refresh: 'renewed-refresh' })),
    invalidate: vi.fn(async () => undefined),
    close: vi.fn(async () => true as const),
    subscribe,
    emit,
  };
};

describe('surreal auth and connection', () => {
  it('stores tokens on sign in', async () => {
    const storage = new MemoryStorage();
    const client = createFakeClient();

    const tokens = await signIn('lawyer@example.com', 'secret', client, storage);

    expect(tokens.access).toBe('access-token');
    expect(getTokens(storage)).toEqual(tokens);
  });

  it('restores and refreshes a saved session', async () => {
    const storage = new MemoryStorage();
    const client = createFakeClient();

    persistTokens({ access: 'stale-access', refresh: 'stale-refresh' }, storage);

    const refreshed = await restoreSession(client, storage);

    expect(client.authenticate).toHaveBeenCalledWith({
      access: 'stale-access',
      refresh: 'stale-refresh',
    });
    expect(refreshed).toEqual({
      access: 'renewed-access',
      refresh: 'renewed-refresh',
    });
    expect(getTokens(storage)).toEqual(refreshed);
  });

  it('clears tokens when restore fails', async () => {
    const storage = new MemoryStorage();
    const client = createFakeClient();

    persistTokens({ access: 'bad-access' }, storage);
    client.authenticate.mockRejectedValueOnce(new Error('expired'));

    const restored = await restoreSession(client, storage);

    expect(restored).toBeNull();
    expect(getTokens(storage)).toBeNull();
  });

  it('invalidates and clears tokens on sign out', async () => {
    const storage = new MemoryStorage();
    const client = createFakeClient();

    persistTokens({ access: 'access-token' }, storage);
    await signOut(client, storage);

    expect(client.invalidate).toHaveBeenCalled();
    expect(getTokens(storage)).toBeNull();
  });

  it('forwards connection options with reconnect enabled', async () => {
    const client = createFakeClient();

    await connectToSurreal(client);

    expect(client.connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reconnect: expect.objectContaining({
          enabled: true,
          attempts: -1,
          retryDelayMax: 30_000,
        }),
      }),
    );
  });

  it('updates connection state from subscribed events', () => {
    const client = createFakeClient();
    const seen: string[] = [];

    connectionState.subscribe((snapshot) => {
      seen.push(snapshot.state);
    });

    attachConnectionListeners(client);
    client.emit('connecting');
    client.emit('reconnecting');
    client.emit('connected', 'ws://localhost:8000/rpc');
    client.emit('auth', { access: 'fresh-token' });
    client.emit('disconnected');

    expect(seen).toContain('connecting');
    expect(seen).toContain('reconnecting');
    expect(seen).toContain('connected');
    expect(seen).toContain('disconnected');
  });

  it('clears malformed saved tokens', () => {
    const storage = new MemoryStorage();

    storage.setItem('surreal_ck.auth.tokens', '{broken json');

    expect(getTokens(storage)).toBeNull();
    clearTokens(storage);
    expect(storage.getItem('surreal_ck.auth.tokens')).toBeNull();
  });
});
