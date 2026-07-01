import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import '@/app/index.css';
import { AppClerkProvider } from '@/auth/clerk-provider';

export function startApp() {
  const container = document.getElementById('root');

  if (!container) {
    throw new Error('Root container not found.');
  }

  document.documentElement.classList.add('dark');
  document.documentElement.dataset.theme = 'dark';

  createRoot(container).render(
    <StrictMode>
      <AppClerkProvider>
        <App />
      </AppClerkProvider>
    </StrictMode>
  );
}
