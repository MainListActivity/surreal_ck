import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppProviders } from './app/providers';
import { AppRouterProvider } from './app/router';
import '@univerjs/preset-sheets-core/lib/index.css';
import './styles/design-system.css';
import './styles/global.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app was not found.');
}

createRoot(app).render(
  <StrictMode>
    <AppProviders>
      <AppRouterProvider />
    </AppProviders>
  </StrictMode>,
);
