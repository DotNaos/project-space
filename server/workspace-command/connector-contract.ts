import type { WorkspaceCommandState } from '../../src/shared/workspace-command-api';

export type WorkspaceCommandConnectorOperation = 'cancel' | 'start' | 'status';

export interface WorkspaceCommandConnectorActor {
  generation: number;
  userId: string;
}

export interface WorkspaceCommandConnectorRequest {
  allowNetwork: boolean;
  command?: string;
  commandId: string;
  commandSha256: string;
  environmentId: string;
  executionId: string;
  expectedHeadSha?: string;
  machineId: string;
  maxOutputBytes: number;
  operation: WorkspaceCommandConnectorOperation;
  projectId: string;
  repositoryWritable: boolean;
  timeoutSeconds: number;
  workspaceId: string;
  workspaceWritable: boolean;
  worktreeId: string;
}

export interface WorkspaceCommandConnectorGrant {
  allowNetwork: boolean;
  commandId: string;
  commandSha256: string;
  environmentId: string;
  executionId: string;
  expectedHeadSha?: string;
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  maxOutputBytes: number;
  nonce: string;
  operation: WorkspaceCommandConnectorOperation;
  projectId: string;
  repositoryWritable: boolean;
  signature: string;
  timeoutSeconds: number;
  userId: string;
  workspaceId: string;
  workspaceWritable: boolean;
  worktreeId: string;
}

export type WorkspaceCommandConnectorWireRequest = WorkspaceCommandConnectorRequest & {
  grant: WorkspaceCommandConnectorGrant;
};

export interface WorkspaceCommandConnectorResult {
  checkedAt: string;
  commandId: string;
  environmentId: string;
  executionId: string;
  exitCode?: number;
  finishedAt?: string;
  generation: number;
  machineId: string;
  operation: WorkspaceCommandConnectorOperation;
  startedAt?: string;
  state: WorkspaceCommandState;
  stderr: string;
  stdout: string;
  truncated: boolean;
  workspaceId: string;
}

export interface WorkspaceCommandConnectorAdapter {
  execute(request: WorkspaceCommandConnectorRequest & {
    actor: WorkspaceCommandConnectorActor;
  }): Promise<WorkspaceCommandConnectorResult>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const digest = /^[0-9a-f]{64}$/;
const worktree = /^wt_[a-f0-9]{24}$/;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isWorkspaceCommandConnectorWireRequest(
  value: unknown
): value is WorkspaceCommandConnectorWireRequest {
  if (!record(value) || !record(value.grant)) return false;
  const grant = value.grant;
  const operation = String(value.operation);
  const exact: string[] = [
    'allowNetwork', 'commandId', 'commandSha256', 'environmentId', 'executionId',
    'expectedHeadSha', 'machineId', 'maxOutputBytes', 'operation', 'projectId',
    'repositoryWritable', 'timeoutSeconds', 'workspaceId', 'workspaceWritable', 'worktreeId'
  ] as const;
  if (!['cancel', 'start', 'status'].includes(operation) || grant.operation !== operation)
    return false;
  if (operation === 'start') exact.push('command');
  const allowed = new Set([...exact, 'grant']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (operation === 'start' ? typeof value.command !== 'string' || value.command.length < 1 ||
      value.command.length > 32_768 : value.command !== undefined) return false;
  const bindings = exact.filter((key) => key !== 'command' && key !== 'expectedHeadSha') as
    Array<keyof WorkspaceCommandConnectorRequest & keyof WorkspaceCommandConnectorGrant>;
  if (bindings.some((key) => grant[key] !== value[key])) return false;
  return uuid.test(String(value.commandId)) && uuid.test(String(value.environmentId)) &&
    uuid.test(String(value.executionId)) && uuid.test(String(value.workspaceId)) &&
    id.test(String(value.machineId)) && id.test(String(value.projectId)) &&
    worktree.test(String(value.worktreeId)) && digest.test(String(value.commandSha256)) &&
    (value.expectedHeadSha === undefined || /^[0-9a-f]{40}$/.test(String(value.expectedHeadSha))) &&
    typeof value.allowNetwork === 'boolean' && typeof value.repositoryWritable === 'boolean' &&
    typeof value.workspaceWritable === 'boolean' &&
    Number.isSafeInteger(value.timeoutSeconds) && Number(value.timeoutSeconds) >= 1 &&
    Number(value.timeoutSeconds) <= 900 && Number.isSafeInteger(value.maxOutputBytes) &&
    Number(value.maxOutputBytes) >= 1_024 && Number(value.maxOutputBytes) <= 262_144 &&
    typeof grant.userId === 'string' && grant.userId.length > 0 && grant.userId.length <= 512 &&
    Number.isSafeInteger(grant.generation) && Number(grant.generation) > 0 &&
    typeof grant.nonce === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(grant.nonce) &&
    date(grant.issuedAt) && date(grant.expiresAt) &&
    typeof grant.signature === 'string' && /^[A-Za-z0-9_-]{40,512}$/.test(grant.signature) &&
    grant.expectedHeadSha === value.expectedHeadSha;
}

export function isWorkspaceCommandConnectorResult(
  value: unknown
): value is WorkspaceCommandConnectorResult {
  if (!record(value)) return false;
  return uuid.test(String(value.commandId)) && uuid.test(String(value.environmentId)) &&
    uuid.test(String(value.executionId)) && uuid.test(String(value.workspaceId)) &&
    id.test(String(value.machineId)) && Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0 && ['cancel', 'start', 'status'].includes(String(value.operation)) &&
    ['queued', 'running', 'completed', 'failed', 'cancelled', 'uncertain', 'unsupported']
      .includes(String(value.state)) && date(value.checkedAt) &&
    (value.startedAt === undefined || date(value.startedAt)) &&
    (value.finishedAt === undefined || date(value.finishedAt)) &&
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode)) &&
    typeof value.stdout === 'string' && Buffer.byteLength(value.stdout) <= 262_144 &&
    typeof value.stderr === 'string' && Buffer.byteLength(value.stderr) <= 262_144 &&
    typeof value.truncated === 'boolean';
}
