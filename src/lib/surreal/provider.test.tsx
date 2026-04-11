import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SurrealProvider, useSurrealClient } from './provider';

vi.mock('../../features/auth/auth', () => ({
  authGateway: {
    validAccessToken: vi.fn(async () => 'access-token'),
  },
  useAuthSnapshot: () => ({
    status: 'authenticated',
    isLoggedIn: true,
    user: {
      sub: 'u1',
      recordId: 'app_user:u1',
    },
    updatedAt: Date.now(),
  }),
}));

function createClient() {
  const query = vi.fn(async () => [{ ok: true }]);

  return {
    connect: vi.fn(async () => true as const),
    use: vi.fn(async () => ({ namespace: 'main', database: 'docs' })),
    authenticate: vi.fn(async () => ({ access: 'renewed-access' })),
    invalidate: vi.fn(async () => undefined),
    close: vi.fn(async () => true as const),
    subscribe: vi.fn(() => () => undefined),
    query,
    __queryMock: query,
  };
}

function QueryConsumer({ requestKey }: { requestKey: number }) {
  const db = useSurrealClient() as unknown as { query: (sql: string) => Promise<unknown> };
  const [status, setStatus] = useState(`idle:${requestKey}`);

  useEffect(() => {
    let active = true;
    setStatus(`loading:${requestKey}`);

    void db.query(`SELECT ${requestKey}`).then(() => {
      if (active) {
        setStatus(`done:${requestKey}`);
      }
    });

    return () => {
      active = false;
    };
  }, [db, requestKey]);

  return <div>{status}</div>;
}

describe('SurrealProvider', () => {
  it('does not reopen the auth gate on rerender after authentication succeeds', async () => {
    const queryClient = new QueryClient();
    const client = createClient();
    const queryMock = client.__queryMock;

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <SurrealProvider client={client as never}>
          <QueryConsumer requestKey={1} />
        </SurrealProvider>
      </QueryClientProvider>,
    );

    await screen.findByText('done:1');
    expect(queryMock).toHaveBeenCalledWith('SELECT 1');

    rerender(
      <QueryClientProvider client={queryClient}>
        <SurrealProvider client={client as never}>
          <QueryConsumer requestKey={2} />
        </SurrealProvider>
      </QueryClientProvider>,
    );

    await screen.findByText('done:2');
    await waitFor(() => {
      expect(queryMock).toHaveBeenCalledWith('SELECT 2');
    });
  });
});
