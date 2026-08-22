import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import '@/app/index.css';
import { AppClerkProvider } from '@/auth/clerk-provider';
import { managedReviewRedirectUrl } from '@/auth/managed-review-origin';
import { DotnaosUiDevTools } from '@/components/ui/dotnaos-ui-devtools';

export function startApp() {
  const secureReviewUrl = managedReviewRedirectUrl(
    window.location.href,
    window.isSecureContext,
    import.meta.env.VITE_PROJECT_SPACE_SECURE_REVIEW_URL
  );
  if (secureReviewUrl) {
    window.location.replace(secureReviewUrl);
    return;
  }
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
      {import.meta.env.DEV && import.meta.env.VITE_DOTNAOS_UI_DEVTOOLS === '1' ? (
        <DotnaosUiDevTools
          componentLabelStorageKey="project-space-ui-dev-labels-v1"
          componentStorageKey="project-space-ui-dev-components-v1"
          defaultDockCorner="bottom-right"
          dockStorageKey="project-space-ui-dev-dock-v1"
          inspectSpacingStorageKey="project-space-ui-dev-spacing-v1"
          showDiagnostics
          storageKey="project-space-ui-dev-slots-v1"
          toolbarExpandedStorageKey="project-space-ui-dev-toolbar-v1"
        />
      ) : null}
    </StrictMode>
  );
}
