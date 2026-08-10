import type {
  RunnerWorkspaceRecord,
  TaskExecutionEvent,
  TaskExecutionExecutorBinding
} from '../../src/shared/task-execution-api';
import type {
  AppendTaskExecutionEventInput,
  StoredTaskExecution,
  TaskExecutionStore,
  TaskExecutionTransition,
  TaskExecutionTransitionResult,
  UpdateTaskExecutionHandoffInput
} from './contracts';
import {
  assertEvent,
  assertExecution,
  assertState,
  executionKey as key,
  isHandoffReference,
  isTaskExecutionTransitionAllowed,
  sameBinding,
  sameExecutionIdentity,
  sameWorkspace
} from './execution-store-records';

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
    return [...this.executions.values()]
      .filter((execution) => execution.ownerUserId === input.ownerUserId)
      .filter((execution) => input.includeArchived || execution.state !== 'archived')
      .filter((execution) => !input.taskId || execution.source.taskId === input.taskId)
      .filter((execution) => !input.environmentId || execution.environmentId === input.environmentId)
      .filter((execution) => !input.agent || execution.agent.kind === input.agent)
      .filter((execution) => !input.state || execution.state === input.state)
      .filter((execution) => !input.before ||
        execution.createdAt < input.before.createdAt ||
        execution.createdAt === input.before.createdAt && execution.id < input.before.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(input.limit, 100)))
      .map((execution) => structuredClone(execution));
  }
  async readByExecutor(
    ownerUserId: string,
    agent: TaskExecutionExecutorBinding['agent'],
    externalId: string
  ) {
    for (const [id, binding] of this.bindings) {
      if (!id.startsWith(`${ownerUserId}\0`) || binding.agent !== agent ||
          binding.externalId !== externalId) continue;
      const execution = this.executions.get(id);
      return execution ? structuredClone(execution) : undefined;
    }
    return undefined;
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
  async updateSource(input: {
    branch: string;
    commit: string;
    executionId: string;
    expectedVersion: number;
    ownerUserId: string;
    repositoryId: string;
    updatedAt: string;
  }): Promise<TaskExecutionTransitionResult> {
    const id = key(input.ownerUserId, input.executionId);
    const current = this.executions.get(id);
    if (current?.source.repositoryId === input.repositoryId &&
        current.source.branch === input.branch && current.source.commit === input.commit) {
      return { execution: structuredClone(current), kind: 'updated' };
    }
    if (!current || current.version !== input.expectedVersion ||
        current.source.repositoryId !== input.repositoryId ||
        current.source.branch !== input.branch || current.source.commit !== undefined ||
        ['completed', 'failed', 'cancelled', 'archived'].includes(current.state)) {
      return { current: current ? structuredClone(current) : undefined, kind: 'conflict' };
    }
    const execution = {
      ...current,
      source: { ...current.source, commit: input.commit },
      updatedAt: input.updatedAt,
      version: current.version + 1
    };
    this.executions.set(id, execution);
    return { execution: structuredClone(execution), kind: 'updated' };
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
  async updateHandoff(input: UpdateTaskExecutionHandoffInput): Promise<TaskExecutionTransitionResult> {
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
