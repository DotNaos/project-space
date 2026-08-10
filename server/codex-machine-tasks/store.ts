import type {
  CodexMachineTaskSendResult,
  CodexMachineTaskStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type { DatabaseQueryClient } from '../database/client';
import { executionEnvironmentAdmissionLock } from '../execution-environment-lifecycle/store';
import type {
  CodexMachineTaskAssociationLookup,
  CodexMachineTaskStartOperation,
  CodexMachineTaskStartPayload,
  CodexMachineTaskSendOperation,
  CodexMachineTasksStore
} from './contracts';

interface StartRow {
  connector_generation: string | number;
  connector_id: string;
  dispatch_operation_id: string;
  durable_operations: boolean;
  physical_machine_id: string;
  result: unknown;
  start_payload: unknown;
  state: 'completed' | 'pending' | 'uncertain';
}

interface StartLookupRow extends StartRow {
  fingerprint_sha256: string;
}

interface OperationRow {
  association_key: string;
  fingerprint_sha256: string;
}

interface SendRow {
  connector_generation: string | number;
  connector_id: string;
  dispatch_attempt: string | number;
  durable_operations: boolean;
  fingerprint_sha256: string;
  operation_id: string;
  owner_user_id: string;
  request_payload: unknown;
  result: unknown;
  state: 'completed' | 'pending' | 'queued' | 'uncertain';
  thread_id: string;
}

export class PostgresCodexMachineTasksStore implements CodexMachineTasksStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async lookupStart(input: { fingerprint: string; operationId: string; userId: string }) {
    const result = await this.client.query<StartLookupRow>(
      `select o.fingerprint_sha256, s.dispatch_operation_id,
              s.connector_generation, s.connector_id, s.durable_operations,
              s.physical_machine_id, s.start_payload, s.state, s.result
         from codex_machine_task_start_operations o
         join codex_machine_task_starts s
           on s.owner_user_id = o.owner_user_id and s.association_key = o.association_key
        where o.owner_user_id = $1 and o.operation_id = $2`,
      [input.userId, input.operationId]
    );
    const row = result.rows[0];
    if (!row) return { kind: 'missing' } as const;
    if (row.fingerprint_sha256 !== input.fingerprint) return { kind: 'conflict' } as const;
    if (row.state === 'completed' && isStartResult(row.result)) {
      return { kind: 'replayed', result: row.result } as const;
    }
    const generation = Number(row.connector_generation);
    if (!Number.isSafeInteger(generation) || generation < 1) return { kind: 'conflict' } as const;
    return row.state === 'pending' || row.state === 'uncertain'
      ? {
          durableOperations: row.durable_operations,
          connectorId: row.connector_id,
          generation,
          kind: 'reserved',
          physicalMachineId: row.physical_machine_id,
          ...(isStartPayload(row.start_payload) ? { startPayload: row.start_payload } : {}),
          state: row.state
        } as const
      : { kind: 'conflict' } as const;
  }

  async findStart(input: {
    connectorId: string;
    issue: number;
    repositoryId: string;
    userId: string;
  }): Promise<CodexMachineTaskAssociationLookup> {
    const result = await this.client.query<Pick<StartRow, 'result' | 'state'>>(
      `select state, result
         from codex_machine_task_starts
        where owner_user_id = $1
          and connector_id = $2
          and start_payload->'issue'->>'number' = $3
          and (
            start_payload->'repository'->>'id' = $4
            or start_payload->'repository'->>'nameWithOwner' = $4
          )
        order by updated_at desc
        limit 1`,
      [input.userId, input.connectorId, String(input.issue), input.repositoryId]
    );
    const row = result.rows[0];
    if (!row) return { kind: 'missing' };
    if (row.state === 'completed' && isStartResult(row.result)) {
      return { kind: 'confirmed', result: row.result };
    }
    return row.state === 'uncertain' ? { kind: 'uncertain' } : { kind: 'pending' };
  }

  async releaseUncertainStart(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }) {
    const run = async (client: DatabaseQueryClient) => {
      const current = await client.query<{
        association_key: string;
        fingerprint_sha256: string;
        state: string | null;
      }>(
        `select o.association_key, o.fingerprint_sha256, s.state
           from codex_machine_task_start_operations o
           join codex_machine_task_starts s
             on s.owner_user_id = o.owner_user_id and s.association_key = o.association_key
          where o.owner_user_id = $1 and o.operation_id = $2
          for update of o, s`,
        [input.userId, input.operationId]
      );
      const row = current.rows[0];
      if (!row) return 'missing' as const;
      if (row.fingerprint_sha256 !== input.fingerprint) return 'conflict' as const;
      if (row.state !== 'uncertain') return 'not_uncertain' as const;
      await client.query(
        `delete from codex_machine_task_start_operations
          where owner_user_id = $1 and association_key = $2`,
        [input.userId, row.association_key]
      );
      const deleted = await client.query<{ association_key: string }>(
        `delete from codex_machine_task_starts
          where owner_user_id = $1 and association_key = $2 and state = 'uncertain'
        returning association_key`,
        [input.userId, row.association_key]
      );
      return deleted.rows.length === 1 ? 'released' as const : 'not_uncertain' as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async reserveStart(operation: CodexMachineTaskStartOperation) {
    const run = async (client: DatabaseQueryClient) => {
      if (!await acquireExecutionEnvironmentAdmission(client, {
        environmentId: operation.physicalMachineId,
        userId: operation.userId
      })) return { kind: 'fenced' } as const;
      const insertedAssociation = await client.query<{ association_key: string }>(
         `insert into codex_machine_task_starts (
           owner_user_id, association_key, dispatch_operation_id,
           connector_generation, durable_operations, physical_machine_id, connector_id,
           start_payload, state
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
         on conflict do nothing
         returning association_key`,
        [operation.userId, operation.associationKey, operation.operationId,
          operation.generation, operation.durableOperations, operation.physicalMachineId,
          operation.connectorId, JSON.stringify(operation.startPayload)]
      );
      const insertedOperation = await client.query<{ operation_id: string }>(
        `insert into codex_machine_task_start_operations (
           owner_user_id, operation_id, association_key, fingerprint_sha256
         ) values ($1, $2, $3, $4)
         on conflict do nothing
         returning operation_id`,
        [operation.userId, operation.operationId, operation.associationKey, operation.fingerprint]
      );
      const operationMapping = await client.query<OperationRow>(
        `select association_key, fingerprint_sha256
           from codex_machine_task_start_operations
          where owner_user_id = $1 and operation_id = $2
          for update`,
        [operation.userId, operation.operationId]
      );
      const mapping = operationMapping.rows[0];
      if (!mapping || mapping.association_key !== operation.associationKey ||
        mapping.fingerprint_sha256 !== operation.fingerprint) {
        if (insertedAssociation.rows.length > 0) {
          await client.query(
            `delete from codex_machine_task_starts
              where owner_user_id = $1 and association_key = $2 and state = 'pending'`,
            [operation.userId, operation.associationKey]
          );
        }
        return { kind: 'conflict' } as const;
      }
      const existing = await client.query<StartRow>(
        `select dispatch_operation_id, connector_generation, durable_operations,
                start_payload, state, result
           from codex_machine_task_starts
          where owner_user_id = $1 and association_key = $2
          for update`,
        [operation.userId, operation.associationKey]
      );
      const row = existing.rows[0];
      if (!row || !isStartPayload(row.start_payload)) return { kind: 'conflict' } as const;
      if (insertedAssociation.rows.length > 0 && insertedOperation.rows.length > 0) {
        return { kind: 'new' } as const;
      }
      if (row.state === 'completed' && isStartResult(row.result)) {
        return { kind: 'replayed', result: row.result } as const;
      }
      const generation = Number(row.connector_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        return { kind: 'conflict' } as const;
      }
      return row.state === 'uncertain'
        ? {
            dispatchOperationId: row.dispatch_operation_id,
            durableOperations: row.durable_operations,
            generation, kind: 'uncertain',
            sameOperation: row.dispatch_operation_id === operation.operationId,
            startPayload: row.start_payload
          } as const
        : {
            dispatchOperationId: row.dispatch_operation_id,
            durableOperations: row.durable_operations,
            generation, kind: 'pending',
            sameOperation: row.dispatch_operation_id === operation.operationId,
            startPayload: row.start_payload
          } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async completeStart(
    operation: CodexMachineTaskStartOperation,
    result: CodexMachineTaskStartResult
  ) {
    await this.transition(operation, 'completed', result);
  }

  async reserveSend(operation: CodexMachineTaskSendOperation) {
    const run = async (client: DatabaseQueryClient) => {
      if (!await acquireExecutionEnvironmentAdmission(client, {
        connectorId: operation.connectorId,
        userId: operation.userId
      })) return { kind: 'fenced' } as const;
      await acquireSendThreadLock(client, operation);
      const inserted = await client.query<{ operation_id: string }>(
        `insert into codex_machine_task_sends (
           owner_user_id, operation_id, connector_id, thread_id,
           connector_generation, durable_operations, fingerprint_sha256, request_payload, state
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
         on conflict do nothing
         returning operation_id`,
        [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
          operation.generation, operation.durableOperations, operation.fingerprint,
          JSON.stringify(operation.request)]
      );
      if (inserted.rows.length > 0) return { kind: 'new' } as const;
      const existing = await client.query<SendRow>(
        `select owner_user_id, operation_id, connector_id, thread_id, connector_generation,
                dispatch_attempt, durable_operations, fingerprint_sha256,
                request_payload, state, result
           from codex_machine_task_sends
          where owner_user_id = $1 and (
            operation_id = $2 or (
              connector_id = $3 and thread_id = $4 and state = 'pending'
            )
          )
          order by (operation_id = $2) desc
          limit 1
          for update`,
        [operation.userId, operation.operationId, operation.connectorId, operation.threadId]
      );
      const row = existing.rows[0];
      if (!row) return { kind: 'fenced' } as const;
      if (row.operation_id !== operation.operationId) return { kind: 'fenced' } as const;
      if (row.connector_id !== operation.connectorId || row.thread_id !== operation.threadId ||
        row.fingerprint_sha256 !== operation.fingerprint) return { kind: 'conflict' } as const;
      if (row.state === 'completed' && isSendResult(row.result)) {
        return { kind: 'replayed', result: row.result } as const;
      }
      if (row.state === 'queued' && isSendResult(row.result)) {
        return { kind: 'replayed', result: row.result } as const;
      }
      if (row.state === 'uncertain') {
      const generation = Number(row.connector_generation);
      const dispatchAttempt = Number(row.dispatch_attempt ?? 0);
      return Number.isSafeInteger(generation) && generation > 0 &&
        Number.isSafeInteger(dispatchAttempt) && dispatchAttempt >= 0
        ? {
            dispatchAttempt, durableOperations: row.durable_operations,
            generation, kind: 'uncertain'
          } as const
        : { kind: 'fenced' } as const;
      }
      const generation = Number(row.connector_generation);
      const dispatchAttempt = Number(row.dispatch_attempt ?? 0);
      return Number.isSafeInteger(generation) && generation > 0 &&
        Number.isSafeInteger(dispatchAttempt) && dispatchAttempt >= 0
        ? {
            dispatchAttempt, durableOperations: row.durable_operations,
            generation, kind: 'pending'
          } as const
        : { kind: 'fenced' } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async completeSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult,
    nextGeneration = operation.generation
  ) {
    if (await this.transitionSend(operation, 'completed', result, nextGeneration)) return;
    const existing = await this.client.query<Pick<SendRow, 'state'>>(
      `select state from codex_machine_task_sends
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and fingerprint_sha256 = $5`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.fingerprint]
    );
    if (existing.rows[0]?.state !== 'completed') {
      throw new Error('Codex task send reservation was not updated.');
    }
  }

  async markSendUncertain(
    operation: CodexMachineTaskSendOperation,
    nextGeneration = operation.generation
  ) {
    if (!await this.transitionSend(operation, 'uncertain', undefined, nextGeneration)) {
      throw new Error('Codex task send reservation was not updated.');
    }
  }

  async markSendQueued(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult,
    nextGeneration = operation.generation
  ) {
    const transitioned = await this.client.query<{ operation_id: string }>(
      `update codex_machine_task_sends
          set state = 'queued', result = $7::jsonb, connector_generation = $8,
              updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state in ('pending', 'queued', 'uncertain')
        returning operation_id`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint, JSON.stringify(result), nextGeneration]
    );
    if (transitioned.rows.length !== 1) {
      throw new Error('Codex task send reservation was not queued.');
    }
  }

  async claimQueuedSend(operation: CodexMachineTaskSendOperation) {
    const run = async (client: DatabaseQueryClient) => {
      await acquireSendThreadLock(client, operation);
      const claimed = await client.query<{ dispatch_attempt: number }>(
        `update codex_machine_task_sends queued
            set state = 'pending', connector_generation = $5,
                dispatch_attempt = dispatch_attempt + 1, updated_at = now()
          where owner_user_id = $1 and operation_id = $2 and connector_id = $3
            and thread_id = $4 and fingerprint_sha256 = $6 and state = 'queued'
            and not exists (
              select 1 from codex_machine_task_sends pending
               where pending.owner_user_id = queued.owner_user_id
                 and pending.connector_id = queued.connector_id
                 and pending.thread_id = queued.thread_id
                 and pending.state = 'pending'
            )
          returning dispatch_attempt`,
        [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
          operation.generation, operation.fingerprint]
      );
      const attempt = Number(claimed.rows[0]?.dispatch_attempt);
      return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async listQueuedSends() {
    const queued = await this.client.query<SendRow>(
      `select owner_user_id, operation_id, connector_id, thread_id, connector_generation,
              dispatch_attempt,
              durable_operations, fingerprint_sha256, request_payload, state, result
         from codex_machine_task_sends
        where state = 'queued'
        order by created_at, operation_id`
    );
    return queued.rows.flatMap((row) => {
      const operation = operationFromSendRow(row, row.owner_user_id);
      return operation ? [operation] : [];
    });
  }

  async listPendingSends() {
    const pending = await this.client.query<SendRow>(
      `select owner_user_id, operation_id, connector_id, thread_id, connector_generation,
              dispatch_attempt,
              durable_operations, fingerprint_sha256, request_payload, state, result
         from codex_machine_task_sends
        where state = 'pending' and request_payload is not null
        order by created_at, operation_id`
    );
    return pending.rows.flatMap((row) => {
      const operation = operationFromSendRow(row, row.owner_user_id);
      return operation ? [operation] : [];
    });
  }

  async nextQueuedSend(input: { connectorId: string; threadId: string; userId: string }) {
    const queued = await this.client.query<SendRow>(
      `select owner_user_id, operation_id, connector_id, thread_id, connector_generation,
              dispatch_attempt,
              durable_operations, fingerprint_sha256, request_payload, state, result
         from codex_machine_task_sends
        where owner_user_id = $1 and connector_id = $2 and thread_id = $3 and state = 'queued'
        order by created_at, operation_id
        limit 1`,
      [input.userId, input.connectorId, input.threadId]
    );
    return operationFromSendRow(queued.rows[0], input.userId);
  }

  async releaseSend(operation: CodexMachineTaskSendOperation) {
    const deleted = await this.client.query<{ operation_id: string }>(
      `delete from codex_machine_task_sends
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state = 'pending'
        returning operation_id`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint]
    );
    if (deleted.rows.length !== 1) throw new Error('Codex task send reservation was not released.');
  }

  async markStartUncertain(operation: CodexMachineTaskStartOperation) {
    await this.transition(operation, 'uncertain');
  }

  async releaseStart(operation: CodexMachineTaskStartOperation) {
    const deleted = await this.client.query<{ association_key: string }>(
      `delete from codex_machine_task_starts
        where owner_user_id = $1 and association_key = $2
          and dispatch_operation_id = $3 and connector_generation = $4
          and state in ('pending', 'uncertain')
        returning association_key`,
      [operation.userId, operation.associationKey, operation.operationId, operation.generation]
    );
    if (deleted.rows.length !== 1) throw new Error('Codex task start reservation was not released.');
  }

  private async transition(
    operation: CodexMachineTaskStartOperation,
    state: 'completed' | 'uncertain',
    result?: CodexMachineTaskStartResult
  ) {
    const transitioned = await this.client.query<{ association_key: string }>(
      `update codex_machine_task_starts
          set state = $5, result = $6::jsonb, updated_at = now()
        where owner_user_id = $1 and association_key = $2
          and dispatch_operation_id = $3 and connector_generation = $4
          and state in ('pending', 'uncertain')
        returning association_key`,
      [operation.userId, operation.associationKey, operation.operationId, operation.generation, state,
        result ? JSON.stringify(result) : null]
    );
    if (transitioned.rows.length !== 1) {
      throw new Error('Codex task start reservation was not updated.');
    }
  }

  private async transitionSend(
    operation: CodexMachineTaskSendOperation,
    state: 'completed' | 'uncertain',
    result?: CodexMachineTaskSendResult,
    nextGeneration = operation.generation
  ) {
    const transitioned = await this.client.query<{ operation_id: string }>(
      `update codex_machine_task_sends
          set state = $7, result = $8::jsonb, connector_generation = $9,
              updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state in ('pending', 'queued', 'uncertain')
        returning operation_id`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint, state,
        result ? JSON.stringify(result) : null, nextGeneration]
    );
    return transitioned.rows.length === 1;
  }
}

async function acquireSendThreadLock(
  client: DatabaseQueryClient,
  operation: Pick<CodexMachineTaskSendOperation, 'connectorId' | 'threadId' | 'userId'>
) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `codex-machine-task-send:${operation.userId}\0${operation.connectorId}\0${operation.threadId}`
  ]);
}

function operationFromSendRow(
  row: SendRow | undefined,
  userId?: string
): CodexMachineTaskSendOperation | undefined {
  if (!row) return undefined;
  const generation = Number(row.connector_generation);
  const dispatchAttempt = Number(row.dispatch_attempt ?? 0);
  if (!userId || !Number.isSafeInteger(generation) || generation < 1 ||
    !Number.isSafeInteger(dispatchAttempt) || dispatchAttempt < 0 ||
    !isSendRequestPayload(row.request_payload)) return undefined;
  return {
    connectorId: row.connector_id,
    dispatchAttempt,
    durableOperations: row.durable_operations,
    fingerprint: row.fingerprint_sha256,
    generation,
    operationId: row.operation_id,
    request: row.request_payload,
    threadId: row.thread_id,
    userId
  };
}

async function acquireExecutionEnvironmentAdmission(
  client: DatabaseQueryClient,
  input: { connectorId?: string; environmentId?: string; userId: string }
) {
  const binding = await client.query<{ environment_id: string }>(
    input.environmentId
      ? `select environment_id::text
           from environment_provider_bindings
          where owner_user_id = $1 and environment_id::text = $2
          limit 1`
      : `select binding.environment_id::text
           from connector_compute_environments association
           join environment_provider_bindings binding
             on binding.owner_user_id = association.owner_user_id
            and binding.environment_id = association.environment_id
          where association.owner_user_id = $1 and association.connector_id = $2
          limit 1`,
    [input.userId, input.environmentId ?? input.connectorId]
  );
  const environmentId = binding.rows[0]?.environment_id;
  if (!environmentId) return true;
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    executionEnvironmentAdmissionLock(input.userId, environmentId)
  ]);
  const lifecycle = await client.query<{ admitted: boolean }>(
    `select binding.lifecycle_state = 'running' and not exists (
       select 1 from environment_lifecycle_operations operation
        where operation.owner_user_id = binding.owner_user_id
          and operation.environment_id = binding.environment_id
          and operation.action in ('stop', 'delete')
          and (
            operation.state = 'dispatching'
            or (operation.state = 'uncertain' and operation.dispatch_attempted)
          )
     ) as admitted
       from environment_provider_bindings binding
      where binding.owner_user_id = $1 and binding.environment_id = $2::uuid
      limit 1`,
    [input.userId, environmentId]
  );
  return lifecycle.rows[0]?.admitted === true;
}

function isStartResult(value: unknown): value is CodexMachineTaskStartResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.apiVersion === 1 && typeof result.operationId === 'string' &&
    typeof result.state === 'string' &&
    ['blocked', 'confirmed', 'ready', 'uncertain'].includes(result.state);
}

function isStartPayload(value: unknown): value is CodexMachineTaskStartPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.branch !== 'string' || !/\S/.test(payload.branch) ||
    typeof payload.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.commit)) {
    return false;
  }
  if (!payload.issue || typeof payload.issue !== 'object' || Array.isArray(payload.issue) ||
    !payload.repository || typeof payload.repository !== 'object' || Array.isArray(payload.repository)) {
    return false;
  }
  const issue = payload.issue as Record<string, unknown>;
  const repository = payload.repository as Record<string, unknown>;
  return Number.isSafeInteger(issue.number) && Number(issue.number) > 0 &&
    typeof issue.url === 'string' && /^https:\/\//.test(issue.url) &&
    typeof repository.id === 'string' && /\S/.test(repository.id) &&
    typeof repository.nameWithOwner === 'string' && /\S+\/\S+/.test(repository.nameWithOwner);
}

function isSendResult(value: unknown): value is CodexMachineTaskSendResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.apiVersion === 1 && typeof result.operationId === 'string' &&
    typeof result.state === 'string' &&
    ['accepted', 'blocked', 'completed', 'queued', 'sent', 'steered', 'uncertain']
      .includes(result.state);
}

function isSendRequestPayload(
  value: unknown
): value is CodexMachineTaskSendOperation['request'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const target = request.target;
  return typeof request.message === 'string' && request.message.length > 0 &&
    typeof request.mode === 'string' && ['auto', 'queue', 'steer'].includes(request.mode) &&
    !!target && typeof target === 'object' && !Array.isArray(target) &&
    typeof (target as Record<string, unknown>).physicalMachineId === 'string' &&
    (target as Record<string, unknown>).physicalMachineId !== '' &&
    ((target as Record<string, unknown>).environmentId === undefined ||
      typeof (target as Record<string, unknown>).environmentId === 'string' &&
      (target as Record<string, unknown>).environmentId !== '') &&
    (request.expectedTurnId === undefined ||
      typeof request.expectedTurnId === 'string' && request.expectedTurnId.length > 0);
}
