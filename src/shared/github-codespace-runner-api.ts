export const GITHUB_CODESPACE_RUNNER_API_VERSION = 1 as const;

export type GitHubCodespaceRunnerAction =
  | 'delete'
  | 'provision'
  | 'start'
  | 'status'
  | 'stop';

export interface GitHubCodespaceRunnerRequest {
  action: GitHubCodespaceRunnerAction;
  branch: string;
  codespaceName?: string;
  issue: number;
  listOnly?: boolean;
  operationId: string;
  repositoryFullName: string;
}

export type GitHubCodespaceRunnerState =
  | 'authorization-required'
  | 'connector-approval-required'
  | 'failed'
  | 'github-reauthorization-required'
  | 'not-created'
  | 'offline'
  | 'provisioning'
  | 'ready';

export interface GitHubCodespaceRunnerResult {
  apiVersion: typeof GITHUB_CODESPACE_RUNNER_API_VERSION;
  approvalUrl?: string;
  codespace?: {
    name: string;
    state: string;
    url?: string;
  };
  codespaces?: Array<{
    name: string;
    state: string;
    url?: string;
  }>;
  connectorId?: string;
  environmentId?: string;
  message: string;
  operationId: string;
  state: GitHubCodespaceRunnerState;
}
