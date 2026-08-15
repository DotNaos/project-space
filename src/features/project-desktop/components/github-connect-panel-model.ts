import type {
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult
} from '@/shared/project-space-api';

export interface GitHubConnectPanelPresentation {
  description: string;
  isLoadError: boolean;
  isPending: boolean;
  primaryActionDisabled: boolean;
  primaryActionLabel: string;
  title: string;
}

export function getGitHubConnectPanelPresentation({
  flow,
  githubCatalog,
  isConnecting
}: {
  flow?: GitHubOAuthDeviceStartResult;
  githubCatalog: GitHubCatalogResult;
  isConnecting: boolean;
}): GitHubConnectPanelPresentation {
  const isLoadError = githubCatalog.status === 'error';
  const isPending = flow?.status === 'pending';

  return {
    description: isLoadError
      ? 'The project catalog could not be loaded.'
      : githubCatalog.message ?? 'Connect GitHub to load repositories and projects.',
    isLoadError,
    isPending,
    primaryActionDisabled:
      isConnecting || githubCatalog.status === 'not-configured',
    primaryActionLabel: isPending
      ? 'Continue GitHub login'
      : githubCatalog.reconnectRequired
        ? 'Reconnect GitHub'
        : 'Login with GitHub',
    title: isLoadError
      ? 'Project catalog unavailable'
      : githubCatalog.reconnectRequired
        ? 'Reconnect your GitHub account'
        : 'Connect your GitHub account'
  };
}
