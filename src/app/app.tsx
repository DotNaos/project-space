import { SsoCallbackScreen } from '@/auth/sso-callback';
import { ConnectorSetupPage } from '@/features/connector-setup/components/connector-setup-page';
import { ProjectDesktopShell } from '@/features/project-desktop/components/project-desktop-shell';

export function App() {
  if (window.location.pathname.startsWith('/connector')) {
    return <ConnectorSetupPage />;
  }

  if (window.location.pathname.startsWith('/sso-callback')) {
    return <SsoCallbackScreen />;
  }

  return <ProjectDesktopShell />;
}
