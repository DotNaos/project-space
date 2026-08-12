export const canonicalRuntimeControlApiVersion = 1 as const;

export const canonicalRuntimeControlOperations = [
  'git.status',
  'git.diff',
  'git.stage',
  'git.unstage',
  'git.commit',
  'worktree.list',
  'task.start',
  'dev-server.inspect',
  'dev-server.start',
  'dev-server.publish',
  'dev-server.stop'
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

export const canonicalRuntimeControlReadOperations = [
  'git.status',
  'git.diff',
  'worktree.list',
  'dev-server.inspect'
] as const;

export const canonicalRuntimeControlMutationOperations = [
  'git.stage',
  'git.unstage',
  'git.commit',
  'task.start',
  'dev-server.start',
  'dev-server.publish',
  'dev-server.stop'
] as const;

export type CanonicalRuntimeControlAccessMode = 'read' | 'mutation';

export type CanonicalRuntimeControlSafeInput =
  | { operation: 'git.status' }
  | { operation: 'git.diff'; staged: boolean }
  | { operation: 'git.stage'; expectedHead: string; scope: 'all' }
  | { operation: 'git.unstage'; expectedHead: string; scope: 'all' }
  | { operation: 'git.commit'; expectedHead: string; message: string }
  | { operation: 'worktree.list' }
  | { operation: 'task.start'; taskExecutionId: string; workspaceLeaseId: string }
  | { operation: 'dev-server.inspect' }
  | { operation: 'dev-server.start'; serverId: string }
  | {
      operation: 'dev-server.publish' | 'dev-server.stop';
      expectedServerGeneration: string;
      serverId: string;
    };

export type CanonicalRuntimeControlInput = CanonicalRuntimeControlSafeInput;

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

export interface CanonicalGitMutationOutput extends CanonicalGitStatusOutput {
  changed: boolean;
  head: string;
}

export interface CanonicalGitCommitOutput {
  commit: string;
  parent: string;
}

export interface CanonicalTaskStartOutput {
  state: 'ready_for_agent';
  taskExecutionId: string;
}

export interface CanonicalDevServerMutationOutput {
  serverGeneration: string;
  serverId: string;
  state: 'published' | 'ready' | 'stopped';
}

export type CanonicalDevServerStartOutput = Omit<CanonicalDevServerMutationOutput, 'state'> & {
  state: 'ready';
};

export type CanonicalDevServerPublishOutput = Omit<CanonicalDevServerMutationOutput, 'state'> & {
  state: 'published';
};

export type CanonicalDevServerStopOutput = Omit<CanonicalDevServerMutationOutput, 'state'> & {
  state: 'stopped';
};

export interface CanonicalRuntimeControlOutputByOperation {
  'dev-server.inspect': CanonicalDevServerInspectOutput;
  'dev-server.publish': CanonicalDevServerPublishOutput;
  'dev-server.start': CanonicalDevServerStartOutput;
  'dev-server.stop': CanonicalDevServerStopOutput;
  'git.commit': CanonicalGitCommitOutput;
  'git.diff': CanonicalGitDiffOutput;
  'git.stage': CanonicalGitMutationOutput;
  'git.status': CanonicalGitStatusOutput;
  'git.unstage': CanonicalGitMutationOutput;
  'task.start': CanonicalTaskStartOutput;
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
      state: 'blocked_dependency' | 'failed' | 'uncertain';
    });

export function canonicalRuntimeControlAccessMode(
  operation: CanonicalRuntimeControlOperation
): CanonicalRuntimeControlAccessMode {
  return (canonicalRuntimeControlReadOperations as readonly string[]).includes(operation)
    ? 'read'
    : 'mutation';
}

export function canonicalRuntimeControlSafeInput(
  request: CanonicalRuntimeControlRequest
): CanonicalRuntimeControlSafeInput {
  switch (request.operation) {
    case 'git.status':
    case 'worktree.list':
    case 'dev-server.inspect':
      return { operation: request.operation };
    case 'git.diff':
      return { operation: request.operation, staged: request.staged };
    case 'git.stage':
    case 'git.unstage':
      return {
        expectedHead: request.expectedHead,
        operation: request.operation,
        scope: request.scope
      };
    case 'git.commit':
      return {
        expectedHead: request.expectedHead,
        message: request.message,
        operation: request.operation
      };
    case 'task.start':
      return {
        operation: request.operation,
        taskExecutionId: request.taskExecutionId,
        workspaceLeaseId: request.workspaceLeaseId
      };
    case 'dev-server.start':
      return { operation: request.operation, serverId: request.serverId };
    case 'dev-server.publish':
    case 'dev-server.stop':
      return {
        expectedServerGeneration: request.expectedServerGeneration,
        operation: request.operation,
        serverId: request.serverId
      };
  }
}
