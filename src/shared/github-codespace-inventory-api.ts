export const GITHUB_CODESPACE_INVENTORY_API_VERSION = 1 as const;

export type GitHubCodespaceInventoryConnectionState =
  | 'connected'
  | 'not_connected'
  | 'scope_insufficient';

export interface GitHubCodespaceInventoryItem {
  createdAt: string;
  displayName?: string;
  name: string;
  ref?: string;
  repositoryFullName: string;
  state: string;
  url?: string;
}

export interface GitHubCodespaceInventoryResult {
  apiVersion: typeof GITHUB_CODESPACE_INVENTORY_API_VERSION;
  checkedAt: string;
  codespaces: GitHubCodespaceInventoryItem[];
  provider: {
    connectionState: GitHubCodespaceInventoryConnectionState;
    source: 'github_api';
  };
}
