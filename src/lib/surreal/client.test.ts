import { describe, expect, it, vi } from 'vitest';

import {
  attachConnectionListeners,
  authenticateSurrealAccessToken,
  beginAuthenticationGate,
  connectionState,
  connectToSurreal,
  gateClientRequests,
} from './client';

const createFakeClient = () => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const query = vi.fn(async (..._args: unknown[]) => [{ ok: true }]);
  const live = vi.fn(async (..._args: unknown[]) => ({ unsubscribe: vi.fn() }));

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
    use: vi.fn(async () => ({ namespace: 'main', database: 'main' })),
    authenticate: vi.fn(async () => ({ access: 'renewed-access' })),
    invalidate: vi.fn(async () => undefined),
    close: vi.fn(async () => true as const),
    query,
    live,
    __queryMock: query,
    subscribe,
    emit,
  };
};

describe('surreal connection', () => {
  it('connects and calls use with namespace/database', async () => {
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
    expect(client.use).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: expect.any(String), database: expect.any(String) }),
    );
  });

  it('authenticates access token and sets connected state', async () => {
    const client = createFakeClient();
    const seen: string[] = [];

    connectionState.subscribe((snapshot) => seen.push(snapshot.state));

    await authenticateSurrealAccessToken('my-access-token', client);

    expect(client.authenticate).toHaveBeenCalledWith('my-access-token');
    expect(seen).toContain('connected');
  });

  it('sets auth-failed state and closes on authentication error', async () => {
    const client = createFakeClient();
    client.authenticate.mockRejectedValueOnce(new Error('invalid token'));

    const seen: string[] = [];
    connectionState.subscribe((snapshot) => seen.push(snapshot.state));

    await expect(authenticateSurrealAccessToken('bad-token', client)).rejects.toThrow('invalid token');

    expect(client.close).toHaveBeenCalled();
    expect(seen).toContain('auth-failed');
  });

  it('queues requests until authentication succeeds', async () => {
    const client = createFakeClient();
    const queryMock = client.__queryMock;

    gateClientRequests(client);
    beginAuthenticationGate(client);

    const pendingQuery = client.query('SELECT * FROM test');
    await Promise.resolve();

    expect(queryMock).not.toHaveBeenCalled();

    await authenticateSurrealAccessToken('my-access-token', client);
    await pendingQuery;

    expect(queryMock).toHaveBeenCalledWith('SELECT * FROM test');
  });

  it('rejects queued requests when authentication fails', async () => {
    const client = createFakeClient();
    const queryMock = client.__queryMock;
    client.authenticate.mockRejectedValueOnce(new Error('invalid token'));

    gateClientRequests(client);
    beginAuthenticationGate(client);

    const pendingQuery = client.query('SELECT * FROM test');
    await Promise.resolve();

    await expect(authenticateSurrealAccessToken('bad-token', client)).rejects.toThrow('invalid token');
    await expect(pendingQuery).rejects.toThrow('invalid token');
    expect(queryMock).not.toHaveBeenCalled();
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

  it('does not attach listeners twice for the same client instance', () => {
    const client = createFakeClient();

    attachConnectionListeners(client);
    attachConnectionListeners(client);

    const eventTypes = client.subscribe.mock.calls.map(([event]) => event);
    expect(eventTypes.filter((e) => e === 'connecting').length).toBe(1);
  });
});
