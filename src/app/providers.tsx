import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { bootstrapAuth } from '../features/auth/auth';
import { SurrealProvider } from '../lib/surreal/provider';

const queryClient = new QueryClient();

void bootstrapAuth().catch(() => undefined);

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SurrealProvider>{children}</SurrealProvider>
    </QueryClientProvider>
  );
}
