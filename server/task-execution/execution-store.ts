import type {
  RunnerWorkspaceRecord,
  TaskExecutionEvent,
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
  executionKey as key,
  executionValues,
  isHandoffReference,
  isTaskExecutionTransitionAllowed,
  type ExecutionRow,
  mapBinding,
  mapEvent,
  mapExecution,
  mapWorkspace,
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
         commit_sha, state, version, created_at, updated_at
       ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)
       on conflict do nothing returning id`,
      [
        workspace.id, workspace.executionId, ownerUserId, workspace.kind,
        workspace.repositoryId, workspace.branch, workspace.commit ?? null,
        workspace.state, workspace.version, workspace.createdAt, workspace.updatedAt
      ]
    );
    if (result.rows[0]) return 'created';
    const existing = await this.readWorkspace(ownerUserId, workspace.executionId);
    return existing && sameWorkspace(existing, workspace) ? 'replayed' : 'conflict';
  }
  async readWorkspace(ownerUserId: string, executionId: string) {
    const result = await this.client.query<WorkspaceRow>(
      `select id, execution_id, kind, repository_id, branch, commit_sha,
              state, version, created_at, updated_at
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
                  state, version, created_at, updated_at`,
      [
        input.ownerUserId, input.executionId, input.expectedVersion, input.state,
        input.commit ?? null, input.updatedAt
      ]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : undefined;
  }
}

export class MemoryTaskExecutionStore implements TaskExecutionStore {
  private readonly executions = new Map<string, StoredTaskExecution>();
  private readonly bindings = new Map<string, TaskExecutionExecutorBinding>();
  private readonly workspaces = new Map<string, RunnerWorkspaceRecord>();
  private readonly events = new Map<string, TaskExecutionEvent[]>();
  private cursor = 0;
  async create(input: StoredTaskExecution) {
    assertExecution(input);
    const id = key(input.ownerUserId, input.id);
    const existing = this.executions.get(id);
    if (existing) return sameExecutionIdentity(existing, input) ? 'replayed' : 'conflict';
    this.executions.set(id, structuredClone(input));
    return 'created';
  }
  async read(ownerUserId: string, executionId: string) {
    const value = this.executions.get(key(ownerUserId, executionId));
    return value ? structuredClone(value) : undefined;
  }
  async transition(input: TaskExecutionTransition): Promise<TaskExecutionTransitionResult> {
    const id = key(input.ownerUserId, input.executionId);
    const current = this.executions.get(id);
    assertState(input.state, input.blockedReason);
    if (!current || current.version !== input.expectedVersion ||
        !isTaskExecutionTransitionAllowed(current.state, input.state)) {
      return { current: current ? structuredClone(current) : undefined, kind: 'conflict' };
    }
    const updated: StoredTaskExecution = {
      ...current,
      blockedReason: input.blockedReason,
      state: input.state,
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.executions.set(id, updated);
    return { execution: structuredClone(updated), kind: 'updated' };
  }

  async updateConnectorBinding(input: {
    connectorBinding: NonNullable<StoredTaskExecution['connectorBinding']>;
    executionId: string;
    expectedConnectorBinding?: StoredTaskExecution['connectorBinding'];
    expectedVersion: number;
    ownerUserId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult> {
    const id = key(input.ownerUserId, input.executionId);
    const current = this.executions.get(id);
    const expected = input.expectedConnectorBinding;
    if (!current || current.version !== input.expectedVersion ||
        ['completed', 'failed', 'cancelled', 'archived'].includes(current.state) ||
        current.connectorBinding?.connectorId !== expected?.connectorId ||
        current.connectorBinding?.generation !== expected?.generation ||
        !Number.isSafeInteger(input.connectorBinding.generation) ||
        input.connectorBinding.generation <= 0 || !input.connectorBinding.connectorId.trim()) {
      return { current: current ? structuredClone(current) : undefined, kind: 'conflict' };
    }
    const execution = {
      ...current,
      connectorBinding: structuredClone(input.connectorBinding),
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.executions.set(id, execution);
    return { execution: structuredClone(execution), kind: 'updated' };
  }

  async updateHandoff(
    input: UpdateTaskExecutionHandoffInput
  ): Promise<TaskExecutionTransitionResult> {
    const id = key(input.ownerUserId, input.executionId);
    const current = this.executions.get(id);
    if (!current || !isHandoffReference(input.handoff) ||
        current.version !== input.expectedVersion ||
        (current.handoff.id === input.handoff.id &&
          current.handoff.revision === input.handoff.revision) ||
        ['completed', 'failed', 'cancelled', 'archived'].includes(current.state)) {
      return { current: current ? structuredClone(current) : undefined, kind: 'conflict' };
    }
    const execution = {
      ...current,
      handoff: structuredClone(input.handoff),
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.executions.set(id, execution);
    await this.appendEvent({
      createdAt: input.updatedAt,
      executionId: input.executionId,
      handoffChange: { from: current.handoff, to: input.handoff },
      ownerUserId: input.ownerUserId,
      type: 'handoff_updated'
    });
    return { execution: structuredClone(execution), kind: 'updated' };
  }

  async archive(ownerUserId: string, executionId: string, expectedVersion: number, archivedAt: string) {
    const current = this.executions.get(key(ownerUserId, executionId));
    if (!current || current.version !== expectedVersion ||
        !['completed', 'failed', 'cancelled'].includes(current.state)) {
      return { current: current ? structuredClone(current) : undefined, kind: 'conflict' } as const;
    }
    const execution: StoredTaskExecution = {
      ...current,
      archivedAt,
      blockedReason: undefined,
      state: 'archived',
      updatedAt: archivedAt,
      version: current.version + 1
    };
    this.executions.set(key(ownerUserId, executionId), execution);
    return { execution: structuredClone(execution), kind: 'updated' } as const;
  }

  async appendEvent(input: AppendTaskExecutionEventInput) {
    assertEvent(input);
    if (!this.executions.has(key(input.ownerUserId, input.executionId))) {
      throw new Error('Task Execution was not found.');
    }
    const event: TaskExecutionEvent = {
      ...(input.actor ? { actor: structuredClone(input.actor) } : {}),
      createdAt: input.createdAt,
      cursor: ++this.cursor,
      executionId: input.executionId,
      ...(input.handoffChange ? { handoffChange: structuredClone(input.handoffChange) } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.state ? { state: input.state } : {}),
      type: input.type
    };
    const id = key(input.ownerUserId, input.executionId);
    this.events.set(id, [...(this.events.get(id) ?? []), event]);
    return structuredClone(event);
  }

  async listEvents(ownerUserId: string, executionId: string, afterCursor = 0, limit = 100) {
    return structuredClone((this.events.get(key(ownerUserId, executionId)) ?? [])
      .filter(({ cursor }) => cursor > afterCursor)
      .slice(0, Math.max(1, Math.min(limit, 200))));
  }

  async bindExecutor(ownerUserId: string, binding: TaskExecutionExecutorBinding) {
    if (binding.version !== 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(binding.externalId)) return 'conflict';
    const id = key(ownerUserId, binding.executionId);
    const existing = this.bindings.get(id);
    if (existing) return sameBinding(existing, binding) ? 'replayed' : 'conflict';
    const execution = this.executions.get(id);
    if (!execution || execution.agent.kind !== binding.agent) return 'conflict';
    if ([...this.bindings.entries()].some(([candidateKey, candidate]) => (
      candidateKey.startsWith(`${ownerUserId}\0`) && candidate.agent === binding.agent &&
      candidate.externalId === binding.externalId
    ))) return 'conflict';
    this.bindings.set(id, structuredClone(binding));
    return 'created';
  }

  async readExecutorBinding(ownerUserId: string, executionId: string) {
    const value = this.bindings.get(key(ownerUserId, executionId));
    return value ? structuredClone(value) : undefined;
  }

  async updateExecutorTurn(input: {
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    turnId: string;
    updatedAt: string;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.turnId)) return undefined;
    const id = key(input.ownerUserId, input.executionId);
    const current = this.bindings.get(id);
    if (!current || current.version !== input.expectedVersion) return undefined;
    const updated = {
      ...current,
      turnId: input.turnId,
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.bindings.set(id, updated);
    return structuredClone(updated);
  }

  async bindWorkspace(ownerUserId: string, workspace: RunnerWorkspaceRecord) {
    if (workspace.version !== 1 ||
        (workspace.commit !== undefined && !/^[0-9a-f]{40}$/.test(workspace.commit))) {
      return 'conflict';
    }
    const id = key(ownerUserId, workspace.executionId);
    const existing = this.workspaces.get(id);
    if (existing) return sameWorkspace(existing, workspace) ? 'replayed' : 'conflict';
    const execution = this.executions.get(id);
    if (!execution || execution.source.repositoryId !== workspace.repositoryId ||
        execution.source.branch !== workspace.branch) return 'conflict';
    this.workspaces.set(id, structuredClone(workspace));
    return 'created';
  }

  async readWorkspace(ownerUserId: string, executionId: string) {
    const value = this.workspaces.get(key(ownerUserId, executionId));
    return value ? structuredClone(value) : undefined;
  }

  async updateWorkspace(input: {
    commit?: string;
    expectedVersion: number;
    executionId: string;
    ownerUserId: string;
    state: RunnerWorkspaceRecord['state'];
    updatedAt: string;
  }) {
    if (input.commit !== undefined && !/^[0-9a-f]{40}$/.test(input.commit)) return undefined;
    const id = key(input.ownerUserId, input.executionId);
    const current = this.workspaces.get(id);
    if (!current || current.version !== input.expectedVersion) return undefined;
    const updated = {
      ...current,
      ...(input.commit ? { commit: input.commit } : {}),
      state: input.state,
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.workspaces.set(id, updated);
    return structuredClone(updated);
  }
}
