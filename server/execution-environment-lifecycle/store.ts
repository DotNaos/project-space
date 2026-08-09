import type { DatabaseQueryClient } from '../database/client';
import type {
  EnvironmentLifecycleAction,
  EnvironmentLifecycleOperation,
  EnvironmentLifecycleReservation,
  EnvironmentLifecycleState,
  EnvironmentLifecycleStore,
  EnvironmentLifecycleStoredResult,
  EnvironmentProviderBinding,
  EnvironmentProviderBindingSaveResult,
  EnvironmentProviderBindingTaskKey
} from './contracts';

export type {
  EnvironmentLifecycleAction,
  EnvironmentLifecycleOperation,
  EnvironmentLifecycleReservation,
  EnvironmentLifecycleState,
  EnvironmentLifecycleStore,
  EnvironmentLifecycleStoredResult,
  EnvironmentProviderBinding,
  EnvironmentProviderBindingSaveResult,
  EnvironmentProviderBindingTaskKey
} from './contracts';

export class EnvironmentProviderBindingConflictError extends Error {
  constructor() {
    super('Multiple provider bindings match this exact task target.');
    this.name = 'EnvironmentProviderBindingConflictError';
  }
}

interface BindingRow {
  branch: string;
  environment_id: string | null;
  id: string;
  lifecycle_state: EnvironmentLifecycleState;
  native_state: string | null;
  observed_at: Date | string;
  owner_user_id: string;
  provider_kind: string;
  provider_resource_id: string;
  repository_full_name: string;
  task_number: number;
}

interface OperationRow {
  action: EnvironmentLifecycleAction;
  fingerprint_sha256: string;
  provider_kind: string;
  result: unknown;
  scope_key: string;
  state: 'completed' | 'dispatching' | 'retryable' | 'uncertain';
}

const bindingColumns = `
  id, owner_user_id, environment_id, provider_kind, provider_resource_id,
  repository_full_name, branch, task_number, lifecycle_state, native_state, observed_at
`;

export class PostgresEnvironmentLifecycleStore implements EnvironmentLifecycleStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async reserve(input: EnvironmentLifecycleOperation) {
    const run = async (client: DatabaseQueryClient): Promise<EnvironmentLifecycleReservation> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        input.environmentId
          ? executionEnvironmentAdmissionLock(input.userId, input.environmentId)
          : `${input.userId}:${input.providerKind}:${input.scopeKey}`
      ]);
      const existing = await this.readOperation(client, input);
      if (existing) return this.existingReservation(client, input, existing);

      const active = await client.query<{ operation_id: string }>(
        `select operation_id
           from environment_lifecycle_operations
          where owner_user_id = $1 and provider_kind = $2 and scope_key = $3
            and (state = 'dispatching' or (state = 'uncertain' and dispatch_attempted))
          limit 1`,
        [input.userId, input.providerKind, input.scopeKey]
      );
      if (active.rows.length > 0) return { kind: 'fenced' };

      const inserted = await client.query<{ operation_id: string }>(
        `insert into environment_lifecycle_operations (
           owner_user_id, operation_id, provider_kind, scope_key, action,
           binding_id, environment_id, fingerprint_sha256, state
         ) values ($1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8, 'dispatching')
         on conflict (owner_user_id, operation_id) do nothing
         returning operation_id`,
        [
          input.userId, input.operationId, input.providerKind, input.scopeKey, input.action,
          input.bindingId ?? null, input.environmentId ?? null, input.fingerprint
        ]
      );
      if (inserted.rows.length > 0) return { kind: 'new' };
      const raced = await this.readOperation(client, input);
      return raced
        ? this.existingReservation(client, input, raced)
        : { kind: 'conflict' };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async complete(
    input: EnvironmentLifecycleOperation,
    result: EnvironmentLifecycleStoredResult
  ) {
    if (result.operationId !== input.operationId) {
      throw new Error('Environment lifecycle result operation ID does not match.');
    }
    await this.transition(input, 'completed', result, false);
  }

  async markRetryable(input: EnvironmentLifecycleOperation) {
    await this.transition(input, 'retryable', undefined, false);
  }

  async markUncertain(input: EnvironmentLifecycleOperation, dispatchAttempted = true) {
    await this.transition(input, 'uncertain', undefined, dispatchAttempted);
  }

  async attachBinding(input: EnvironmentLifecycleOperation & {
    bindingId: string;
    environmentId?: string;
  }) {
    const updated = await this.client.query<{ operation_id: string }>(
      `update environment_lifecycle_operations
          set binding_id = $7::uuid,
              environment_id = coalesce(environment_id, $8::uuid),
              updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and provider_kind = $3
          and scope_key = $4 and action = $5 and fingerprint_sha256 = $6
          and (environment_id is null or environment_id = $8::uuid)
        returning operation_id`,
      [
        input.userId, input.operationId, input.providerKind, input.scopeKey,
        input.action, input.fingerprint, input.bindingId, input.environmentId ?? null
      ]
    );
    return updated.rows.length === 1;
  }

  async saveBinding(input: EnvironmentProviderBinding) {
    const run = async (client: DatabaseQueryClient): Promise<EnvironmentProviderBindingSaveResult> => {
      const lockKeys = [
        `environment-provider:${input.userId}:${input.providerKind}:${input.providerResourceId}`,
        ...(input.environmentId
          ? [`environment-binding:${input.userId}:${input.environmentId}`]
          : [])
      ].sort();
      await client.query(
        `select pg_advisory_xact_lock(hashtext(lock_key))
           from (select unnest($1::text[]) as lock_key order by 1) locks`,
        [lockKeys]
      );
      const conflicts = await client.query<BindingRow>(
        `select ${bindingColumns}
           from environment_provider_bindings
          where owner_user_id = $1 and (
            (provider_kind = $2 and provider_resource_id = $3)
            or ($4::uuid is not null and environment_id = $4::uuid)
          )
          for update`,
        [input.userId, input.providerKind, input.providerResourceId, input.environmentId ?? null]
      );
      const providerMatch = (row: typeof conflicts.rows[number]) => (
        row.provider_kind === input.providerKind &&
        row.provider_resource_id === input.providerResourceId
      );
      if (conflicts.rows.some((row) => (
        !providerMatch(row) && row.environment_id === input.environmentId
      )) || conflicts.rows.some((row) => (
        providerMatch(row) && row.environment_id && input.environmentId &&
        row.environment_id !== input.environmentId
      )) || conflicts.rows.some((row) => (
        providerMatch(row) && !sameBindingTarget(row, input)
      ))) return { kind: 'conflict' };
      const current = conflicts.rows.find(providerMatch);
      if (current && Date.parse(String(current.observed_at)) > Date.parse(input.observedAt)) {
        return { binding: mapBinding(current), kind: 'saved' };
      }

      const saved = await client.query<BindingRow>(
        `insert into environment_provider_bindings (
           id, owner_user_id, environment_id, provider_kind, provider_resource_id,
           repository_full_name, branch, task_number, lifecycle_state, native_state, observed_at
         ) values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         on conflict (owner_user_id, provider_kind, provider_resource_id) do update set
           environment_id = coalesce(environment_provider_bindings.environment_id, excluded.environment_id),
           lifecycle_state = excluded.lifecycle_state,
           native_state = excluded.native_state,
           observed_at = excluded.observed_at,
           updated_at = now()
         returning id, owner_user_id, environment_id, provider_kind, provider_resource_id,
                   repository_full_name, branch, task_number, lifecycle_state,
                   native_state, observed_at`,
        [
          input.id, input.userId, input.environmentId ?? null, input.providerKind,
          input.providerResourceId, input.repositoryFullName, input.branch, input.task,
          input.lifecycleState, input.nativeState ?? null, input.observedAt
        ]
      );
      const row = saved.rows[0];
      return row
        ? { binding: mapBinding(row), kind: 'saved' }
        : { kind: 'conflict' };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async readBindingByEnvironment(userId: string, environmentId: string) {
    const result = await this.client.query<BindingRow>(
      `select ${bindingColumns}
         from environment_provider_bindings
        where owner_user_id = $1 and environment_id = $2::uuid`,
      [userId, environmentId]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }

  async readBindingByTask(input: EnvironmentProviderBindingTaskKey) {
    const result = await this.client.query<BindingRow>(
      `select ${bindingColumns}
         from environment_provider_bindings
        where owner_user_id = $1 and provider_kind = $2
          and lower(repository_full_name) = lower($3)
          and task_number = $4 and branch = $5 and lifecycle_state <> 'deleted'
        order by updated_at desc, id
        limit 2`,
      [input.userId, input.providerKind, input.repositoryFullName, input.task, input.branch]
    );
    if (result.rows.length > 1) throw new EnvironmentProviderBindingConflictError();
    return result.rows[0] ? mapBinding(result.rows[0]) : undefined;
  }

  async listBindings(userId: string) {
    const result = await this.client.query<BindingRow>(
      `select ${bindingColumns}
         from environment_provider_bindings
        where owner_user_id = $1
        order by updated_at desc, id`,
      [userId]
    );
    return result.rows.map(mapBinding);
  }

  private async readOperation(client: DatabaseQueryClient, input: EnvironmentLifecycleOperation) {
    const result = await client.query<OperationRow>(
      `select provider_kind, scope_key, action, fingerprint_sha256, state, result
         from environment_lifecycle_operations
        where owner_user_id = $1 and operation_id = $2
        for update`,
      [input.userId, input.operationId]
    );
    return result.rows[0];
  }

  private async existingReservation(
    client: DatabaseQueryClient,
    input: EnvironmentLifecycleOperation,
    row: OperationRow
  ): Promise<EnvironmentLifecycleReservation> {
    if (row.provider_kind !== input.providerKind || row.scope_key !== input.scopeKey ||
        row.action !== input.action || row.fingerprint_sha256 !== input.fingerprint) {
      return { kind: 'conflict' };
    }
    if (row.state === 'completed' && isStoredResult(row.result, input.operationId)) {
      return { kind: 'replayed', result: row.result };
    }
    if (row.state === 'retryable') {
      await client.query(
        `update environment_lifecycle_operations
            set state = 'dispatching', dispatch_attempted = false, result = null,
                updated_at = now()
          where owner_user_id = $1 and operation_id = $2 and state = 'retryable'`,
        [input.userId, input.operationId]
      );
      return { kind: 'new' };
    }
    return { kind: row.state === 'uncertain' ? 'uncertain' : 'pending' };
  }

  private async transition(
    input: EnvironmentLifecycleOperation,
    state: 'completed' | 'retryable' | 'uncertain',
    result: EnvironmentLifecycleStoredResult | undefined,
    dispatchAttempted: boolean
  ) {
    const updated = await this.client.query<{ operation_id: string }>(
      `update environment_lifecycle_operations
          set state = $7, dispatch_attempted = $8, result = $9::jsonb, updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and provider_kind = $3
          and scope_key = $4 and action = $5 and fingerprint_sha256 = $6
          and state in ('dispatching', 'uncertain')
        returning operation_id`,
      [
        input.userId, input.operationId, input.providerKind, input.scopeKey,
        input.action, input.fingerprint, state, dispatchAttempted,
        result ? JSON.stringify(result) : null
      ]
    );
    if (updated.rows.length !== 1) {
      throw new Error('Environment lifecycle operation was not updated.');
    }
  }
}

interface MemoryOperation {
  dispatchAttempted: boolean;
  input: EnvironmentLifecycleOperation;
  result?: EnvironmentLifecycleStoredResult;
  state: 'completed' | 'dispatching' | 'retryable' | 'uncertain';
}

export class MemoryEnvironmentLifecycleStore implements EnvironmentLifecycleStore {
  private readonly bindings = new Map<string, EnvironmentProviderBinding>();
  private readonly operations = new Map<string, MemoryOperation>();

  async reserve(input: EnvironmentLifecycleOperation): Promise<EnvironmentLifecycleReservation> {
    const key = operationKey(input.userId, input.operationId);
    const existing = this.operations.get(key);
    if (existing) return memoryReservation(existing, input);
    const active = [...this.operations.values()].find((candidate) => (
      candidate.input.userId === input.userId &&
      candidate.input.providerKind === input.providerKind &&
      candidate.input.scopeKey === input.scopeKey &&
      (candidate.state === 'dispatching' ||
        (candidate.state === 'uncertain' && candidate.dispatchAttempted))
    ));
    if (active) return { kind: 'fenced' };
    this.operations.set(key, {
      dispatchAttempted: false,
      input: structuredClone(input),
      state: 'dispatching'
    });
    return { kind: 'new' };
  }

  async complete(input: EnvironmentLifecycleOperation, result: EnvironmentLifecycleStoredResult) {
    if (result.operationId !== input.operationId) {
      throw new Error('Environment lifecycle result operation ID does not match.');
    }
    this.transition(input, 'completed', result, false);
  }

  async markRetryable(input: EnvironmentLifecycleOperation) {
    this.transition(input, 'retryable', undefined, false);
  }

  async markUncertain(input: EnvironmentLifecycleOperation, dispatchAttempted = true) {
    this.transition(input, 'uncertain', undefined, dispatchAttempted);
  }

  async attachBinding(input: EnvironmentLifecycleOperation & {
    bindingId: string;
    environmentId?: string;
  }) {
    const operation = this.operations.get(operationKey(input.userId, input.operationId));
    if (!operation || !sameOperation(operation.input, input) ||
        (operation.input.environmentId && operation.input.environmentId !== input.environmentId)) {
      return false;
    }
    operation.input.bindingId = input.bindingId;
    operation.input.environmentId ??= input.environmentId;
    return true;
  }

  async saveBinding(input: EnvironmentProviderBinding) {
    const key = bindingKey(input.userId, input.providerKind, input.providerResourceId);
    const existing = this.bindings.get(key);
    if (existing && !sameBindingTarget(existing, input)) return { kind: 'conflict' as const };
    if (existing?.environmentId && input.environmentId &&
        existing.environmentId !== input.environmentId) return { kind: 'conflict' as const };
    const environmentConflict = [...this.bindings.values()].some((binding) => (
      input.environmentId && binding.userId === input.userId &&
      binding.environmentId === input.environmentId && binding.id !== (existing?.id ?? input.id)
    ));
    if (environmentConflict) return { kind: 'conflict' as const };
    if (existing && Date.parse(existing.observedAt) > Date.parse(input.observedAt)) {
      return { binding: structuredClone(existing), kind: 'saved' as const };
    }
    const binding = structuredClone({
      ...input,
      id: existing?.id ?? input.id,
      environmentId: existing?.environmentId ?? input.environmentId
    });
    this.bindings.set(key, binding);
    return { binding: structuredClone(binding), kind: 'saved' as const };
  }

  async readBindingByEnvironment(userId: string, environmentId: string) {
    const binding = [...this.bindings.values()].find((candidate) => (
      candidate.userId === userId && candidate.environmentId === environmentId
    ));
    return binding ? structuredClone(binding) : undefined;
  }

  async readBindingByTask(input: EnvironmentProviderBindingTaskKey) {
    const matches = [...this.bindings.values()].filter((binding) => (
      binding.userId === input.userId && binding.providerKind === input.providerKind &&
      binding.repositoryFullName.toLowerCase() === input.repositoryFullName.toLowerCase() &&
      binding.task === input.task && binding.branch === input.branch &&
      binding.lifecycleState !== 'deleted'
    ));
    if (matches.length > 1) throw new EnvironmentProviderBindingConflictError();
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }

  async listBindings(userId: string) {
    return [...this.bindings.values()]
      .filter((binding) => binding.userId === userId)
      .map((binding) => structuredClone(binding));
  }

  private transition(
    input: EnvironmentLifecycleOperation,
    state: MemoryOperation['state'],
    result: EnvironmentLifecycleStoredResult | undefined,
    dispatchAttempted: boolean
  ) {
    const operation = this.operations.get(operationKey(input.userId, input.operationId));
    if (!operation || !sameOperation(operation.input, input) ||
        !['dispatching', 'uncertain'].includes(operation.state)) {
      throw new Error('Environment lifecycle operation was not updated.');
    }
    operation.dispatchAttempted = dispatchAttempted;
    operation.result = result ? structuredClone(result) : undefined;
    operation.state = state;
  }
}

function memoryReservation(
  existing: MemoryOperation,
  input: EnvironmentLifecycleOperation
): EnvironmentLifecycleReservation {
  if (!sameOperation(existing.input, input)) return { kind: 'conflict' };
  if (existing.state === 'completed' && existing.result) {
    return { kind: 'replayed', result: structuredClone(existing.result) };
  }
  if (existing.state === 'retryable') {
    existing.dispatchAttempted = false;
    existing.result = undefined;
    existing.state = 'dispatching';
    return { kind: 'new' };
  }
  return { kind: existing.state === 'uncertain' ? 'uncertain' : 'pending' };
}

function sameOperation(left: EnvironmentLifecycleOperation, right: EnvironmentLifecycleOperation) {
  return left.userId === right.userId && left.operationId === right.operationId &&
    left.providerKind === right.providerKind && left.scopeKey === right.scopeKey &&
    left.action === right.action && left.fingerprint === right.fingerprint;
}

function operationKey(userId: string, operationId: string) {
  return `${userId}\0${operationId}`;
}

export function executionEnvironmentAdmissionLock(userId: string, environmentId: string) {
  return `environment-lifecycle:${userId}:${environmentId}`;
}

function bindingKey(userId: string, providerKind: string, providerResourceId: string) {
  return `${userId}\0${providerKind}\0${providerResourceId}`;
}

function sameBindingTarget(
  left: EnvironmentProviderBinding | BindingRow,
  right: EnvironmentProviderBinding
) {
  const repository = 'repositoryFullName' in left
    ? left.repositoryFullName
    : left.repository_full_name;
  const task = 'task' in left ? left.task : left.task_number;
  return repository.toLowerCase() === right.repositoryFullName.toLowerCase() &&
    left.branch === right.branch && task === right.task;
}

function isStoredResult(value: unknown, operationId: string): value is EnvironmentLifecycleStoredResult {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (value as { operationId?: unknown }).operationId === operationId;
}

function mapBinding(row: BindingRow): EnvironmentProviderBinding {
  return {
    branch: row.branch,
    environmentId: row.environment_id ?? undefined,
    id: row.id,
    lifecycleState: row.lifecycle_state,
    nativeState: row.native_state ?? undefined,
    observedAt: new Date(row.observed_at).toISOString(),
    providerKind: row.provider_kind,
    providerResourceId: row.provider_resource_id,
    repositoryFullName: row.repository_full_name,
    task: row.task_number,
    userId: row.owner_user_id
  };
}
