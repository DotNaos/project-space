import { SsoCallbackScreen } from '@/auth/sso-callback';
import { PrototypeReviewAuthBoundary } from '@/auth/prototype-review-auth-boundary';
import { ConnectorSetupPage } from '@/features/connector-setup/components/connector-setup-page';
import { PrototypeReviewPage } from '@/features/pr-preview-review/prototype-review-page';
import { ProjectDesktopShell } from '@/features/project-desktop/components/project-desktop-shell';
import { PreviewHubPage } from '@/features/pr-preview-hub/preview-hub-page';
import { McpOAuthAuthorizationPage } from '@/features/mcp/mcp-oauth-authorization-page';
import { isPreviewHubHostname } from '@/shared/preview-host';

export function App() {
  if (window.location.pathname.startsWith('/mcp/authorize')) {
    return <McpOAuthAuthorizationPage />;
  }

  if (window.location.pathname.startsWith('/connector')) {
    return <ConnectorSetupPage />;
  }

  if (window.location.pathname.startsWith('/sso-callback')) {
    return <SsoCallbackScreen />;
  }

  if (window.location.pathname.startsWith('/prototype-review')) {
    return (
      <PrototypeReviewAuthBoundary>
        <PrototypeReviewPage />
      </PrototypeReviewAuthBoundary>
    );
  }

  if (isPreviewHubHostname(window.location.hostname) || window.location.pathname.startsWith('/preview-hub')) {
    return <PreviewHubPage />;
  }

  return <ProjectDesktopShell />;
}
