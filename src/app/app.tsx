import { useEffect } from 'react';
import { SsoCallbackScreen } from '@/auth/sso-callback';
import { PrototypeReviewAuthBoundary } from '@/auth/prototype-review-auth-boundary';
import { MachineConnectionApprovalPage } from '@/features/machine-connection/components/machine-connection-approval-page';
import { PrototypeReviewPage } from '@/features/pr-preview-review/prototype-review-page';
import { PreviewAccessGatePage } from '@/features/pr-preview-navigation/preview-access-gate-page';
import { PreviewSurfaceSwitcher } from '@/features/pr-preview-navigation/preview-surface-switcher';
import { ProjectDesktopShell } from '@/features/project-desktop/components/project-desktop-shell';
import { PreviewHubPage } from '@/features/pr-preview-hub/preview-hub-page';
import { McpOAuthAuthorizationPage } from '@/features/mcp/mcp-oauth-authorization-page';
import { isCentralPreviewHubHostname, previewPullRequestNumberFromHostname } from '@/shared/preview-host';

function EnvironmentSetupRedirect() {
  useEffect(() => {
    window.location.replace('/docs/environments/setup');
  }, []);

  return null;
}

export function App() {
  const previewPullRequestNumber = previewPullRequestNumberFromHostname(window.location.hostname);

  if (window.location.pathname.startsWith('/mcp/authorize')) {
    return <McpOAuthAuthorizationPage />;
  }

  if (window.location.pathname === '/machines/connect') {
    const requestId = new URLSearchParams(window.location.search).get('request')?.trim() ?? '';
    return <MachineConnectionApprovalPage requestId={requestId} />;
  }

  if (window.location.pathname === '/environments/setup') {
    return <EnvironmentSetupRedirect />;
  }

  if (window.location.pathname.startsWith('/sso-callback')) {
    return <SsoCallbackScreen />;
  }

  if (window.location.pathname === '/preview-access') {
    return <PreviewAccessGatePage />;
  }

  if (window.location.pathname.startsWith('/prototype-review')) {
    return (
      <PrototypeReviewAuthBoundary>
        <PrototypeReviewPage />
      </PrototypeReviewAuthBoundary>
    );
  }

  if (
    isCentralPreviewHubHostname(window.location.hostname) ||
    window.location.pathname.startsWith('/preview-hub')
  ) {
    return <PreviewHubPage />;
  }

  return (
    <>
      <ProjectDesktopShell />
      {previewPullRequestNumber ? (
        <PreviewSurfaceSwitcher
          className="fixed left-1/2 top-3 z-[80] -translate-x-1/2"
          current="full"
          pullRequestNumber={previewPullRequestNumber}
        />
      ) : null}
    </>
  );
}
