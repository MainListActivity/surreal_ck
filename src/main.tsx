import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './workbook/App';
import './styles/design-system.css';
import './styles/global.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app was not found.');
}

createRoot(app).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
