import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SurrealProvider } from './surreal/provider';
import { App } from './workbook/App';
import './styles/design-system.css';
import './styles/global.css';

const queryClient = new QueryClient();
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app was not found.');
}

createRoot(app).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SurrealProvider>
        <App />
      </SurrealProvider>
    </QueryClientProvider>
  </StrictMode>,
);
