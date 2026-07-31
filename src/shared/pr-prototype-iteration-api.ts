import type { PullRequestPrototypeSurfaceKind } from './pr-preview-test-surfaces-api';
import type { DevServerState } from './dev-server-api';

export interface PullRequestPrototypeEvidence {
  branchName?: string;
  codexTask?: {
    checkedAt: string;
    threadId: string;
    title: string;
  };
  connectorId?: string;
  headSha: string;
  machineId?: string;
  machineName?: string;
  projectId?: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  serverId?: string;
  worktreeId?: string;
  worktreePath?: string;
}

export interface PullRequestPrototypeIdentity {
  branchName: string;
  codexTask: {
    checkedAt: string;
    threadId: string;
    title: string;
  };
  connectorId: string;
  headSha: string;
  machineId: string;
  machineName: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  serverId: string;
  surface: PullRequestPrototypeSurfaceKind;
  worktreeId: string;
  worktreePath: string;
}

export type PullRequestPrototypeIterationReason =
  | 'codex-task-missing'
  | 'codex-task-mismatched'
  | 'codex-task-stale'
  | 'dev-server-undeclared'
  | 'evidence-ambiguous'
  | 'head-mismatch'
  | 'machine-offline'
  | 'machine-stale'
  | 'pull-request-closed'
  | 'repository-unauthorized'
  | 'repository-unavailable'
  | 'worktree-mismatched'
  | 'worktree-missing';

export type PullRequestPrototypeIterationResult =
  | {
      action: 'open';
      checkedAt: string;
      identity: PullRequestPrototypeIdentity;
      leaseExpiresAt: string;
      state: 'available';
      url: string;
    }
  | {
      action: 'start';
      checkedAt: string;
      identity: PullRequestPrototypeIdentity;
      serverStartedAt?: string;
      serverState: DevServerState;
      state: 'startable';
    }
  | {
      action: 'none';
      checkedAt: string;
      evidence: PullRequestPrototypeEvidence;
      reasonCode: PullRequestPrototypeIterationReason;
      state: 'mismatched' | 'offline' | 'stale' | 'unauthorized' | 'unavailable';
    };

export interface PullRequestPrototypeIterationRequest {
  headSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  surface: PullRequestPrototypeSurfaceKind;
}
