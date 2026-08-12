export const canonicalRuntimeControlApiVersion = 1 as const;

export const canonicalRuntimeControlOperations = [
  'git.status',
  'git.diff',
  'git.stage',
  'git.unstage',
  'git.commit',
  'worktree.list',
  'worktree.prepare',
  'task.start',
  'codex.start',
  'codex.attach',
  'codex.steer',
  'codex.stop',
  'dev-server.start',
  'dev-server.inspect',
  'dev-server.publish',
  'dev-server.stop'
] as const;

export type CanonicalRuntimeControlOperation =
  typeof canonicalRuntimeControlOperations[number];

export type CanonicalRuntimeControlPayloadValue =
  | boolean
  | null
  | number
  | string;

export interface CanonicalRuntimeControlRequest {
  apiVersion: typeof canonicalRuntimeControlApiVersion;
  environmentId: string;
  expectedGeneration: string;
  expectedTargetIdentityRevision: string;
  operation: CanonicalRuntimeControlOperation;
  operationId: string;
  payload?: Record<string, CanonicalRuntimeControlPayloadValue>;
  workspaceId: string;
}

export interface LegacyConnectorControlAliasRequest {
  apiVersion: typeof canonicalRuntimeControlApiVersion;
  connectorId: string;
  expectedGeneration: string;
  operation: CanonicalRuntimeControlOperation;
  operationId: string;
  payload?: Record<string, CanonicalRuntimeControlPayloadValue>;
  workspaceId: string;
}

export interface CanonicalRuntimeControlResult {
  apiVersion: typeof canonicalRuntimeControlApiVersion;
  compatibilityAlias: boolean;
  environmentId: string;
  generation: string;
  operation: CanonicalRuntimeControlOperation;
  operationId: string;
  output?: Record<string, CanonicalRuntimeControlPayloadValue>;
  replayed: boolean;
  state: 'completed' | 'failed' | 'uncertain';
  targetIdentityRevision: string;
  workspaceId: string;
}
