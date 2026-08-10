import type {
  RunnerWorkspaceRecord,
  TaskExecutionExecutorBinding
} from '../../src/shared/task-execution-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  AppendTaskExecutionEventInput,
  StoredTaskExecution,
  TaskExecutionStore,
  TaskExecutionTransition,
  TaskExecutionTransitionResult,
  UpdateTaskExecutionHandoffInput
} from './contracts';
import { updatePostgresTaskExecutionHandoff } from './execution-handoff';
import {
  assertEvent,
  assertExecution,
  assertState,
  type BindingRow,
  type EventRow,
  executionColumns,
  executionValues,
  isHandoffReference,
  type ExecutionRow,
  mapBinding,
  mapEvent,
  mapExecution,
  mapWorkspace,
  qualifiedExecutionColumns,
  sameBinding,
  sameExecutionIdentity,
  sameWorkspace,
  sourceStatesForTaskExecutionTransition,
  type WorkspaceRow
} from './execution-store-records';

export class PostgresTaskExecutionStore implements TaskExecutionStore {
  constructor(private readonly client: DatabaseQueryClient) {}
  async create(input: StoredTaskExecution) {
    assertExecution(input);
    const result = await this.client.query<ExecutionRow>(
      `insert into task_executions (
         id, owner_user_id, task_id, handoff_id, handoff_revision, agent_kind,
         environment_id, connector_id, connector_generation, repository_id,
         branch, commit_sha, state, blocked_reason, version, created_at, updated_at, archived_at
       ) values (
         $1::uuid, $2, $3, $4::uuid, $5, $6, $7::uuid, $8, $9, $10,
         $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz, $18::timestamptz
       ) on conflict (id, owner_user_id) do nothing
       returning ${executionColumns}`,
      executionValues(input)
    );
    if (result.rows[0]) return 'created';
    const existing = await this.read(input.ownerUserId, input.id);
    return existing && sameExecutionIdentity(existing, input) ? 'replayed' : 'conflict';
  }
  async read(ownerUserId: string, executionId: string) {
    const result = await this.client.query<ExecutionRow>(
      `select ${executionColumns} from task_executions
        where owner_user_id = $1 and id = $2::uuid`,
      [ownerUserId, executionId]
    );
    return result.rows[0] ? mapExecution(result.rows[0]) : undefined;
  }
  async list(input: {
    agent?: StoredTaskExecution['agent']['kind'];
    before?: { createdAt: string; id: string };
    environmentId?: string;
    includeArchived: boolean;
    limit: number;
    ownerUserId: string;
    state?: StoredTaskExecution['state'];
    taskId?: string;
  }) {
    const result = await this.client.query<ExecutionRow>(
      `select ${executionColumns} from task_executions
        where owner_user_id = $1
          and ($2::text is null or task_id = $2)
          and ($3::uuid is null or environment_id = $3::uuid)
          and ($4::text is null or agent_kind = $4)
          and ($5::text is null or state = $5)
          and ($6::boolean or state <> 'archived')
          and ($7::timestamptz is null or (created_at, id) < ($7::timestamptz, $8::uuid))
        order by created_at desc, id desc
        limit $9`,
      [
        input.ownerUserId, input.taskId ?? null, input.environmentId ?? null,
        input.agent ?? null, input.state ?? null, input.includeArchived,
        input.before?.createdAt ?? null, input.before?.id ?? null,
        Math.max(1, Math.min(input.limit, 100))
      ]
    );
    return result.rows.map(mapExecution);
  }
  async readByExecutor(
    ownerUserId: string,
    agent: TaskExecutionExecutorBinding['agent'],
    externalId: string
  ) {
    const result = await this.client.query<ExecutionRow>(
      `select ${qualifiedExecutionColumns('e')}
         from task_execution_bindings b
         join task_executions e
           on e.id = b.execution_id and e.owner_user_id = b.owner_user_id
        where b.owner_user_id = $1 and b.agent_kind = $2 and b.external_id = $3`,
      [ownerUserId, agent, externalId]
    );
    return result.rows[0] ? mapExecution(result.rows[0]) : undefined;
  }
  async transition(input: TaskExecutionTransition): Promise<TaskExecutionTransitionResult> {
    assertState(input.state, input.blockedReason);
    const result = await this.client.query<ExecutionRow>(
      `update task_executions
          set state = $4, blocked_reason = $5, version = version + 1,
              updated_at = $6::timestamptz
        where owner_user_id = $1 and id = $2::uuid and version = $3
          and state = any($7::text[])
        returning ${executionColumns}`,
      [
        input.ownerUserId, input.executionId, input.expectedVersion, input.state,
        input.blockedReason ?? null, input.updatedAt,
        sourceStatesForTaskExecutionTransition(input.state)
      ]
    );
    if (result.rows[0]) return { execution: mapExecution(result.rows[0]), kind: 'updated' };
    return { current: await this.read(input.ownerUserId, input.executionId), kind: 'conflict' };
  }
  async updateSource(input: {
    branch: string;
    commit: string;
    executionId: string;
    expectedVersion: number;
    ownerUserId: string;
    repositoryId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult> {
    const result = await this.client.query<ExecutionRow>(
      `update task_executions
          set commit_sha = $6, version = version + 1, updated_at = $7::timestamptz
        where owner_user_id = $1 and id = $2::uuid and version = $3
          and repository_id = $4 and branch = $5
          and (commit_sha is null or commit_sha = $6)
          and state not in ('completed', 'failed', 'cancelled', 'archived')
        returning ${executionColumns}`,
      [
        input.ownerUserId, input.executionId, input.expectedVersion,
        input.repositoryId, input.branch, input.commit, input.updatedAt
      ]
    );
    if (result.rows[0]) return { execution: mapExecution(result.rows[0]), kind: 'updated' };
    const current = await this.read(input.ownerUserId, input.executionId);
    if (current?.source.repositoryId === input.repositoryId &&
        current.source.branch === input.branch && current.source.commit === input.commit) {
      return { execution: current, kind: 'updated' };
    }
    return { current, kind: 'conflict' };
  }
  async updateConnectorBinding(input: {
    connectorBinding: NonNullable<StoredTaskExecution['connectorBinding']>;
    executionId: string;
    expectedConnectorBinding?: StoredTaskExecution['connectorBinding'];
    expectedVersion: number;
    ownerUserId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult> {
    if (!Number.isSafeInteger(input.connectorBinding.generation) ||
        input.connectorBinding.generation <= 0 || !input.connectorBinding.connectorId.trim()) {
      throw new Error('Task Execution connector binding is invalid.');
    }
    const result = await this.client.query<ExecutionRow>(
      `update task_executions
          set connector_id = $6, connector_generation = $7, version = version + 1,
              updated_at = $8::timestamptz
        where owner_user_id = $1 and id = $2::uuid and version = $3
          and (($4::text is null and connector_id is null) or
               (connector_id = $4 and connector_generation = $5))
          and state not in ('completed', 'failed', 'cancelled', 'archived')
        returning ${executionColumns}`,
      [
        input.ownerUserId, input.executionId, input.expectedVersion,
        input.expectedConnectorBinding?.connectorId ?? null,
        input.expectedConnectorBinding?.generation ?? null,
        input.connectorBinding.connectorId, input.connectorBinding.generation, input.updatedAt
      ]
    );
    if (result.rows[0]) return { execution: mapExecution(result.rows[0]), kind: 'updated' };
    return { current: await this.read(input.ownerUserId, input.executionId), kind: 'conflict' };
  }
  async updateHandoff(
    input: UpdateTaskExecutionHandoffInput
  ): Promise<TaskExecutionTransitionResult> {
    if (!isHandoffReference(input.handoff)) return {
      current: await this.read(input.ownerUserId, input.executionId), kind: 'conflict'
    };
    const run = (client: DatabaseQueryClient) => updatePostgresTaskExecutionHandoff(client, input);
    const row = this.client.transaction ? await this.client.transaction(run) : await run(this.client);
    if (row) return { execution: mapExecution(row), kind: 'updated' };
    return { current: await this.read(input.ownerUserId, input.executionId), kind: 'conflict' };
  }
  async archive(
    ownerUserId: string,
    executionId: string,
    expectedVersion: number,
    archivedAt: string
  ): Promise<TaskExecutionTransitionResult> {
    const result = await this.client.query<ExecutionRow>(
      `update task_executions
          set state = 'archived', blocked_reason = null, archived_at = $4::timestamptz,
              updated_at = $4::timestamptz, version = version + 1
        where owner_user_id = $1 and id = $2::uuid and version = $3
          and state in ('completed', 'failed', 'cancelled')
        returning ${executionColumns}`,
      [ownerUserId, executionId, expectedVersion, archivedAt]
    );
    if (result.rows[0]) return { execution: mapExecution(result.rows[0]), kind: 'updated' };
    return { current: await this.read(ownerUserId, executionId), kind: 'conflict' };
  }
  async appendEvent(input: AppendTaskExecutionEventInput) {
    assertEvent(input);
    const result = await this.client.query<EventRow>(
      `insert into task_execution_events (
         execution_id, owner_user_id, event_type, state, message, actor_kind,
         actor_id, previous_handoff_id, previous_handoff_revision, handoff_id,
         handoff_revision, created_at
       ) values (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10::uuid, $11,
         $12::timestamptz
       )
       returning cursor, execution_id, event_type, state, message, actor_kind,
                 actor_id, previous_handoff_id, previous_handoff_revision,
                 handoff_id, handoff_revision, created_at`,
      [
        input.executionId, input.ownerUserId, input.type, input.state ?? null,
        input.message ?? null, input.actor?.kind ?? null, input.actor?.id ?? null,
        input.handoffChange?.from.id ?? null, input.handoffChange?.from.revision ?? null,
        input.handoffChange?.to.id ?? null, input.handoffChange?.to.revision ?? null,
        input.createdAt
      ]
    );
    if (!result.rows[0]) throw new Error('Task Execution event was not appended.');
    return mapEvent(result.rows[0]);
  }
  async listEvents(ownerUserId: string, executionId: string, afterCursor = 0, limit = 100) {
    const result = await this.client.query<EventRow>(
      `select cursor, execution_id, event_type, state, message, actor_kind, actor_id,
              previous_handoff_id, previous_handoff_revision, handoff_id,
              handoff_revision, created_at
         from task_execution_events
        where owner_user_id = $1 and execution_id = $2::uuid and cursor > $3
        order by cursor
        limit $4`,
      [ownerUserId, executionId, afterCursor, Math.max(1, Math.min(limit, 200))]
    );
    return result.rows.map(mapEvent);
  }
  async bindExecutor(ownerUserId: string, binding: TaskExecutionExecutorBinding) {
    if (binding.version !== 1) return 'conflict';
    const result = await this.client.query<{ execution_id: string }>(
      `insert into task_execution_bindings (
         execution_id, owner_user_id, agent_kind, external_id, turn_id, version,
         created_at, updated_at
       ) values ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       on conflict do nothing returning execution_id`,
      [
        binding.executionId, ownerUserId, binding.agent, binding.externalId,
        binding.turnId ?? null, binding.version, binding.createdAt, binding.updatedAt
      ]
    );
    if (result.rows[0]) return 'created';
    const existing = await this.readExecutorBinding(ownerUserId, binding.executionId);
    return existing && sameBinding(existing, binding) ? 'replayed' : 'conflict';
  }
  async readExecutorBinding(ownerUserId: string, executionId: string) {
    const result = await this.client.query<BindingRow>(
      `select execution_id, agent_kind, external_id, turn_id, version, created_at, updated_at
         from task_execution_bindings
        where owner_user_id = $1 and execution_id = $2::uuid`,
      [ownerUserId, executionId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }
  async updateExecutorTurn(input: {
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }) {
    const result = await this.client.query<BindingRow>(
      `update task_execution_bindings
          set turn_id = $4, version = version + 1, updated_at = $5::timestamptz
        where owner_user_id = $1 and execution_id = $2::uuid and version = $3
        returning execution_id, agent_kind, external_id, turn_id, version, created_at, updated_at`,
      [input.ownerUserId, input.executionId, input.expectedVersion, input.turnId, input.updatedAt]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }
  async bindWorkspace(ownerUserId: string, workspace: RunnerWorkspaceRecord) {
    if (workspace.version !== 1) return 'conflict';
    const result = await this.client.query<{ id: string }>(
      `insert into runner_workspaces (
       id, execution_id, owner_user_id, kind, repository_id, branch,
         commit_sha, state, target_kind, target_reference, version, created_at, updated_at
       ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz)
       on conflict do nothing returning id`,
      [
        workspace.id, workspace.executionId, ownerUserId, workspace.kind,
        workspace.repositoryId, workspace.branch, workspace.commit ?? null,
        workspace.state, workspace.target?.kind ?? null, workspace.target?.reference ?? null,
        workspace.version, workspace.createdAt, workspace.updatedAt
      ]
    );
    if (result.rows[0]) return 'created';
    const existing = await this.readWorkspace(ownerUserId, workspace.executionId);
    return existing && sameWorkspace(existing, workspace) ? 'replayed' : 'conflict';
  }
  async readWorkspace(ownerUserId: string, executionId: string) {
    const result = await this.client.query<WorkspaceRow>(
      `select id, execution_id, kind, repository_id, branch, commit_sha,
              state, target_kind, target_reference, version, created_at, updated_at
         from runner_workspaces
        where owner_user_id = $1 and execution_id = $2::uuid`,
      [ownerUserId, executionId]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : undefined;
  }
  async updateWorkspace(input: {
    commit?: string;
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    state: RunnerWorkspaceRecord['state'];
    updatedAt: string;
  }) {
    const result = await this.client.query<WorkspaceRow>(
      `update runner_workspaces
          set state = $4, commit_sha = coalesce($5, commit_sha),
              version = version + 1, updated_at = $6::timestamptz
        where owner_user_id = $1 and execution_id = $2::uuid and version = $3
        returning id, execution_id, kind, repository_id, branch, commit_sha,
                  state, target_kind, target_reference, version, created_at, updated_at`,
      [
        input.ownerUserId, input.executionId, input.expectedVersion, input.state,
        input.commit ?? null, input.updatedAt
      ]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : undefined;
  }
}

export { MemoryTaskExecutionStore } from './memory-execution-store';
