export const canonicalRuntimeControlApiVersion = 1 as const;

export const canonicalRuntimeControlOperations = [
  'git.status',
  'git.diff',
  'worktree.list',
  'dev-server.inspect'
] as const;

export type CanonicalRuntimeControlOperation =
  typeof canonicalRuntimeControlOperations[number];

interface CanonicalRuntimeControlRequestBinding {
  apiVersion: typeof canonicalRuntimeControlApiVersion;
  environmentId: string;
  expectedGeneration: string;
  expectedTargetIdentityRevision: string;
  operationId: string;
  workspaceId: string;
}

export type CanonicalRuntimeControlInput =
  | { operation: 'git.status' }
  | { operation: 'git.diff'; staged: boolean }
  | { operation: 'worktree.list' }
  | { operation: 'dev-server.inspect' };

export type CanonicalRuntimeControlRequest = CanonicalRuntimeControlRequestBinding &
  CanonicalRuntimeControlInput;

export interface CanonicalGitStatusOutput {
  clean: boolean;
  conflicted: number;
  staged: number;
  truncated: boolean;
  unstaged: number;
  untracked: number;
}

export interface CanonicalGitDiffOutput {
  addedLines: number;
  binaryFiles: number;
  changedFiles: number;
  deletedLines: number;
  staged: boolean;
  truncated: boolean;
}

export interface CanonicalWorktreeListOutput {
  current: number;
  detached: number;
  locked: number;
  prunable: number;
  total: number;
  truncated: boolean;
}

export interface CanonicalDevServerInspectOutput {
  failed: number;
  ready: number;
  starting: number;
  stopped: number;
  total: number;
}

export interface CanonicalRuntimeControlOutputByOperation {
  'dev-server.inspect': CanonicalDevServerInspectOutput;
  'git.diff': CanonicalGitDiffOutput;
  'git.status': CanonicalGitStatusOutput;
  'worktree.list': CanonicalWorktreeListOutput;
}

export type CanonicalRuntimeControlOutput =
  CanonicalRuntimeControlOutputByOperation[CanonicalRuntimeControlOperation];

interface CanonicalRuntimeControlResultBinding {
  apiVersion: typeof canonicalRuntimeControlApiVersion;
  compatibilityAlias: boolean;
  environmentId: string;
  generation: string;
  operationId: string;
  replayed: boolean;
  targetIdentityRevision: string;
  workspaceId: string;
}

type CanonicalRuntimeControlCompletedResult = {
  [Operation in CanonicalRuntimeControlOperation]: CanonicalRuntimeControlResultBinding & {
    operation: Operation;
    output: CanonicalRuntimeControlOutputByOperation[Operation];
    state: 'completed';
  }
}[CanonicalRuntimeControlOperation];

export type CanonicalRuntimeControlResult =
  | CanonicalRuntimeControlCompletedResult
  | (CanonicalRuntimeControlResultBinding & {
      operation: CanonicalRuntimeControlOperation;
      state: 'failed' | 'uncertain';
    });
