export interface RuntimeSession {
  id: string;
  worktreeId: string;
  label: string;
  kind: 'dev-server' | 'preview' | 'runtime';
  status: 'idle' | 'starting' | 'running' | 'stopped';
  portHint?: number;
}

export interface IntegrationRequest {
  id: string;
  sourceWorktreeId: string;
  targetBranchName: string;
  status: 'draft' | 'validated' | 'ready' | 'integrated';
  summary: string;
}
