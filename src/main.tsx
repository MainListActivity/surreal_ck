import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { bootstrapSurreal } from './surreal/bootstrap';
import { registerAppServiceWorker } from './surreal/service-worker';
import { App } from './workbook/App';
import './styles/design-system.css';
import './styles/global.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app was not found.');
}

void registerAppServiceWorker();
void bootstrapSurreal();

createRoot(app).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
