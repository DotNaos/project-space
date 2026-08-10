import type {
  RunnerWorkspaceRecord,
  TaskExecutionEvent,
  TaskExecutionExecutorBinding
} from '../../src/shared/task-execution-api';
import type { AppendTaskExecutionEventInput, StoredTaskExecution } from './contracts';

export interface ExecutionRow {
  agent_kind: StoredTaskExecution['agent']['kind'];
  archived_at: Date | string | null;
  blocked_reason: StoredTaskExecution['blockedReason'] | null;
  branch: string;
  commit_sha: string | null;
  connector_generation: number | string | null;
  connector_id: string | null;
  created_at: Date | string;
  environment_id: string;
  handoff_id: string;
  handoff_revision: number | string;
  id: string;
  owner_user_id: string;
  repository_id: string;
  state: StoredTaskExecution['state'];
  task_id: string;
  updated_at: Date | string;
  version: number | string;
}

export interface BindingRow {
  agent_kind: TaskExecutionExecutorBinding['agent'];
  created_at: Date | string;
  execution_id: string;
  external_id: string;
  turn_id: string | null;
  updated_at: Date | string;
  version: number | string;
}

export interface WorkspaceRow {
  branch: string;
  commit_sha: string | null;
  created_at: Date | string;
  execution_id: string;
  id: string;
  kind: RunnerWorkspaceRecord['kind'];
  repository_id: string;
  state: RunnerWorkspaceRecord['state'];
  target_kind: string | null;
  target_reference: string | null;
  updated_at: Date | string;
  version: number | string;
}

export interface EventRow {
  actor_id: string | null;
  actor_kind: NonNullable<TaskExecutionEvent['actor']>['kind'] | null;
  created_at: Date | string;
  cursor: number | string;
  event_type: TaskExecutionEvent['type'];
  execution_id: string;
  handoff_id: string | null;
  handoff_revision: number | string | null;
  message: string | null;
  previous_handoff_id: string | null;
  previous_handoff_revision: number | string | null;
  state: TaskExecutionEvent['state'] | null;
}

const executionColumnNames = [
  'id', 'owner_user_id', 'task_id', 'handoff_id', 'handoff_revision', 'agent_kind',
  'environment_id', 'connector_id', 'connector_generation', 'repository_id', 'branch',
  'commit_sha', 'state', 'blocked_reason', 'version', 'created_at', 'updated_at', 'archived_at'
] as const;

export const executionColumns = executionColumnNames.join(', ');

export function qualifiedExecutionColumns(alias: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('SQL alias is invalid.');
  return executionColumnNames.map((column) => `${alias}.${column}`).join(', ');
}

export function executionValues(input: StoredTaskExecution) {
  return [
    input.id, input.ownerUserId, input.source.taskId, input.handoff.id,
    input.handoff.revision, input.agent.kind, input.environmentId,
    input.connectorBinding?.connectorId ?? null,
    input.connectorBinding?.generation ?? null, input.source.repositoryId,
    input.source.branch, input.source.commit ?? null, input.state,
    input.blockedReason ?? null, input.version, input.createdAt, input.updatedAt,
    input.archivedAt ?? null
  ];
}

export function mapExecution(row: ExecutionRow): StoredTaskExecution {
  return {
    agent: { kind: row.agent_kind },
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    ...(row.connector_id && row.connector_generation !== null ? {
      connectorBinding: {
        connectorId: row.connector_id,
        generation: Number(row.connector_generation)
      }
    } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    environmentId: row.environment_id,
    handoff: { id: row.handoff_id, revision: Number(row.handoff_revision) },
    id: row.id,
    ownerUserId: row.owner_user_id,
    source: {
      branch: row.branch,
      ...(row.commit_sha ? { commit: row.commit_sha } : {}),
      repositoryId: row.repository_id,
      taskId: row.task_id
    },
    state: row.state,
    updatedAt: new Date(row.updated_at).toISOString(),
    version: Number(row.version)
  };
}

export function mapBinding(row: BindingRow): TaskExecutionExecutorBinding {
  return {
    agent: row.agent_kind,
    createdAt: new Date(row.created_at).toISOString(),
    executionId: row.execution_id,
    externalId: row.external_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: Number(row.version)
  };
}

export function mapWorkspace(row: WorkspaceRow): RunnerWorkspaceRecord {
  return {
    branch: row.branch,
    ...(row.commit_sha ? { commit: row.commit_sha } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    executionId: row.execution_id,
    id: row.id,
    kind: row.kind,
    repositoryId: row.repository_id,
    state: row.state,
    ...(row.target_kind === 'project_worktree' && row.target_reference ? {
      target: { kind: 'project_worktree' as const, reference: row.target_reference }
    } : {}),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: Number(row.version)
  };
}

export function mapEvent(row: EventRow): TaskExecutionEvent {
  return {
    ...(row.actor_kind && row.actor_id ? { actor: { id: row.actor_id, kind: row.actor_kind } } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    cursor: Number(row.cursor),
    executionId: row.execution_id,
    ...(row.previous_handoff_id && row.previous_handoff_revision !== null &&
        row.handoff_id && row.handoff_revision !== null ? {
      handoffChange: {
        from: { id: row.previous_handoff_id, revision: Number(row.previous_handoff_revision) },
        to: { id: row.handoff_id, revision: Number(row.handoff_revision) }
      }
    } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.state ? { state: row.state } : {}),
    type: row.event_type
  };
}

export function sameExecutionIdentity(left: StoredTaskExecution, right: StoredTaskExecution) {
  return left.source.taskId === right.source.taskId &&
    left.handoff.id === right.handoff.id && left.handoff.revision === right.handoff.revision &&
    left.agent.kind === right.agent.kind && left.environmentId === right.environmentId &&
    left.connectorBinding?.connectorId === right.connectorBinding?.connectorId &&
    left.connectorBinding?.generation === right.connectorBinding?.generation &&
    left.source.repositoryId === right.source.repositoryId &&
    left.source.branch === right.source.branch && left.source.commit === right.source.commit;
}

export function sameBinding(
  left: TaskExecutionExecutorBinding,
  right: TaskExecutionExecutorBinding
) {
  return left.agent === right.agent && left.executionId === right.executionId &&
    left.externalId === right.externalId && left.turnId === right.turnId && right.version === 1;
}

export function sameWorkspace(left: RunnerWorkspaceRecord, right: RunnerWorkspaceRecord) {
  return left.id === right.id && left.executionId === right.executionId &&
    left.kind === right.kind && left.repositoryId === right.repositoryId &&
    left.branch === right.branch && left.commit === right.commit &&
    left.target?.kind === right.target?.kind &&
    left.target?.reference === right.target?.reference && right.version === 1;
}

export function assertExecution(input: StoredTaskExecution) {
  assertState(input.state, input.blockedReason);
  if (!uuidPattern.test(input.id) || !uuidPattern.test(input.handoff.id) ||
      !uuidPattern.test(input.environmentId) || !input.ownerUserId.trim() ||
      !input.source.taskId.trim() || input.source.taskId.length > 512 ||
      !input.source.repositoryId.trim() || input.source.repositoryId.length > 512 ||
      !input.source.branch.trim() || input.source.branch.length > 256 ||
      (input.source.commit !== undefined && !/^[0-9a-f]{40}$/.test(input.source.commit)) ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      !Number.isFinite(Date.parse(input.updatedAt)) ||
      input.version !== 1 || input.archivedAt || input.state !== 'planned' ||
      (input.connectorBinding && (!Number.isSafeInteger(input.connectorBinding.generation) ||
        input.connectorBinding.generation <= 0 || !input.connectorBinding.connectorId.trim()))) {
    throw new Error('Task Execution is invalid.');
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertState(
  state: StoredTaskExecution['state'],
  blockedReason: StoredTaskExecution['blockedReason'] | undefined
) {
  if ((state === 'blocked') !== Boolean(blockedReason)) {
    throw new Error('Task Execution blocked state is invalid.');
  }
}

export function assertEvent(input: AppendTaskExecutionEventInput) {
  const handoffChangeValid = input.handoffChange !== undefined &&
    isHandoffReference(input.handoffChange.from) && isHandoffReference(input.handoffChange.to) &&
    (input.handoffChange.from.id !== input.handoffChange.to.id ||
      input.handoffChange.from.revision !== input.handoffChange.to.revision);
  if ((input.type === 'handoff_updated') !== (input.handoffChange !== undefined) ||
      (input.handoffChange !== undefined && !handoffChangeValid) ||
      (input.message?.length ?? 0) > 2_000 || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Task Execution event is invalid.');
  }
}

const terminalStates = new Set<StoredTaskExecution['state']>([
  'archived', 'cancelled', 'completed', 'failed'
]);

const nextStates: Partial<Record<StoredTaskExecution['state'], StoredTaskExecution['state'][]>> = {
  planned: ['preparing_environment', 'preparing_workspace', 'starting_agent'],
  preparing_environment: ['waiting_for_connector', 'waiting_for_authorization', 'preparing_workspace'],
  waiting_for_connector: ['waiting_for_authorization', 'preparing_workspace'],
  waiting_for_authorization: ['preparing_workspace'],
  preparing_workspace: ['starting_agent'],
  starting_agent: ['running'],
  running: ['waiting_for_approval', 'waiting_for_input', 'verifying'],
  waiting_for_approval: ['running', 'verifying'],
  waiting_for_input: ['running', 'verifying'],
  verifying: ['running', 'delivering'],
  delivering: ['completed']
};

export function isTaskExecutionTransitionAllowed(
  from: StoredTaskExecution['state'],
  to: StoredTaskExecution['state']
) {
  if (terminalStates.has(from) || to === 'archived' || to === 'planned') return false;
  if (from === 'blocked' || from === 'uncertain') return true;
  if (to === 'blocked' || to === 'uncertain' || to === 'failed' || to === 'cancelled') return true;
  return nextStates[from]?.includes(to) ?? false;
}

export function sourceStatesForTaskExecutionTransition(to: StoredTaskExecution['state']) {
  return taskExecutionStates.filter((from) => isTaskExecutionTransitionAllowed(from, to));
}

const taskExecutionStates: StoredTaskExecution['state'][] = [
  'planned', 'preparing_environment', 'waiting_for_connector', 'waiting_for_authorization',
  'preparing_workspace', 'starting_agent', 'running', 'waiting_for_approval',
  'waiting_for_input', 'verifying', 'delivering', 'blocked', 'uncertain',
  'completed', 'failed', 'cancelled', 'archived'
];

export function isHandoffReference(handoff: StoredTaskExecution['handoff']) {
  return uuidPattern.test(handoff.id) && Number.isSafeInteger(handoff.revision) &&
    handoff.revision > 0;
}

export function executionKey(ownerUserId: string, executionId: string) {
  return `${ownerUserId}\0${executionId}`;
}
