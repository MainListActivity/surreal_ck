import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SurrealProvider, useSurreal } from './provider';

vi.mock('./client', () => ({
  connectionState: {
    subscribe: (cb: (s: { state: string }) => void) => {
      cb({ state: 'connected' });
      return () => undefined;
    },
  },
  dbQuery: vi.fn(async () => []),
  dbCreate: vi.fn(async () => ({})),
  dbMerge: vi.fn(async () => ({})),
  dbDelete: vi.fn(async () => undefined),
  dbUpsert: vi.fn(async () => ({})),
  onChangefeed: vi.fn(() => () => undefined),
  onSyncStatus: vi.fn(() => () => undefined),
}));

function StatusConsumer() {
  const { isConnected } = useSurreal();
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    setStatus(isConnected ? 'connected' : 'disconnected');
  }, [isConnected]);

  return <div>{status}</div>;
}

describe('SurrealProvider', () => {
  it('子组件通过 useSurreal 可获得 isConnected=true（本地 DB 始终连接）', async () => {
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <SurrealProvider>
          <StatusConsumer />
        </SurrealProvider>
      </QueryClientProvider>,
    );

    await screen.findByText('connected');
  });
});
