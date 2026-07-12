export type WorktreeMaterializeState = 'created' | 'ready' | 'error';
export type WorktreeSetupState =
  | 'required'
  | 'running'
  | 'ready'
  | 'failed'
  | 'interrupted'
  | 'stale';

export interface WorktreeMaterializeRequest {
  branchName: string;
  machineId: string;
  projectId: string;
}

export interface WorktreeSetupInspectRequest {
  machineId: string;
  projectId: string;
  worktreeId: string;
}

export interface WorktreeSetupRunRequest extends WorktreeSetupInspectRequest {
  setupStepId: string;
}

export interface WorktreeMaterializeResult {
  branchName: string;
  checkedAt: string;
  commitSha: string;
  lastError?: string;
  machineId: string;
  projectId: string;
  state: WorktreeMaterializeState;
  worktreeId?: string;
}

export interface WorktreeSetupStepRecord {
  checkedAt: string;
  commitSha: string;
  declarationDigest: string;
  finishedAt?: string;
  lastError?: string;
  setupStepId: string;
  startedAt?: string;
  state: WorktreeSetupState;
}

export interface WorktreeSetupResult {
  capability: 'configured' | 'unavailable';
  checkedAt: string;
  lastError?: string;
  machineId: string;
  projectId: string;
  steps: WorktreeSetupStepRecord[];
  worktreeId: string;
}
