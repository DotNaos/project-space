import type {
  CodexMachineTaskSendResult,
  CodexMachineTaskStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type { DatabaseQueryClient } from '../database/client';
import { executionEnvironmentAdmissionLock } from '../execution-environment-lifecycle/store';
import type {
  CodexMachineTaskAssociationLookup,
  CodexMachineTaskQueuedSend,
  CodexMachineTaskSendLookup,
  CodexMachineTaskStartOperation,
  CodexMachineTaskStartPayload,
  CodexMachineTaskSendOperation,
  CodexMachineTasksStore
} from './contracts';
import { CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN } from '../../src/shared/codex-machine-tasks-api';

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
  delivery: CodexMachineTaskSendOperation['delivery'];
  dispatch_delivery: CodexMachineTaskSendOperation['dispatchDelivery'];
  dispatch_attempt: number;
  durable_operations: boolean;
  expected_turn_id: string | null;
  fingerprint_sha256: string;
  operation_id: string;
  message: string | null;
  request_fingerprint_sha256: string | null;
  result: unknown;
  state: 'completed' | 'pending' | 'queued' | 'uncertain';
  thread_id: string;
}

export class PostgresCodexMachineTasksStore implements CodexMachineTasksStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async lookupStart(input: { fingerprint: string; legacyFingerprint?: string; operationId: string; userId: string }) {
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
    const legacy = isLegacyStartPayload(row.start_payload) || isLegacyStartResult(row.result);
    if (row.fingerprint_sha256 !== input.fingerprint &&
        !(legacy && input.legacyFingerprint === row.fingerprint_sha256)) {
      return { kind: 'conflict' } as const;
    }
    if (legacy) {
      const generation = Number(row.connector_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) return { kind: 'conflict' } as const;
      return {
        connectorId: row.connector_id,
        durableOperations: row.durable_operations,
        generation,
        kind: 'legacy',
        physicalMachineId: row.physical_machine_id,
        state: row.state
      } as const;
    }
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

  async lookupSend(input: {
    connectorId: string;
    fingerprint: string;
    operationId: string;
    threadId: string;
    userId: string;
  }): Promise<CodexMachineTaskSendLookup> {
    const result = await this.client.query<SendRow>(
      `select operation_id, connector_id, thread_id, connector_generation,
              durable_operations, fingerprint_sha256, state, result,
              delivery, dispatch_delivery, expected_turn_id, dispatch_attempt
         from codex_machine_task_sends
        where owner_user_id = $1 and operation_id = $2`,
      [input.userId, input.operationId]
    );
    const row = result.rows[0];
    if (!row) return { kind: 'missing' };
    if (row.connector_id !== input.connectorId || row.thread_id !== input.threadId ||
        row.fingerprint_sha256 !== input.fingerprint) return { kind: 'conflict' };
    return sendLookup(row);
  }

  async lookupSendRequest(input: {
    fingerprint: string;
    operationId: string;
    userId: string;
  }): Promise<CodexMachineTaskSendLookup> {
    const result = await this.client.query<SendRow>(
      `select operation_id, connector_id, thread_id, connector_generation,
              durable_operations, fingerprint_sha256, request_fingerprint_sha256, state, result,
              delivery, dispatch_delivery, expected_turn_id, dispatch_attempt
         from codex_machine_task_sends
        where owner_user_id = $1 and operation_id = $2`,
      [input.userId, input.operationId]
    );
    const row = result.rows[0];
    if (!row || !row.request_fingerprint_sha256) return { kind: 'missing' };
    if (row.request_fingerprint_sha256 !== input.fingerprint) return { kind: 'conflict' };
    return sendLookup(row);
  }

  async listQueuedSends(): Promise<CodexMachineTaskQueuedSend[]> {
    const queued = await this.client.query<SendRow & { owner_user_id: string }>(
      `select owner_user_id, operation_id, connector_id, thread_id, connector_generation,
              durable_operations, fingerprint_sha256, state, result, delivery, dispatch_delivery,
              expected_turn_id, message, request_fingerprint_sha256, dispatch_attempt
        from codex_machine_task_sends
        where state = 'queued'
           or (state in ('pending', 'uncertain') and delivery = 'queue')
        order by created_at`
    );
    return queued.rows.flatMap((row) => {
      const generation = Number(row.connector_generation);
      if (!Number.isSafeInteger(generation) || generation < 1 || !row.message ||
          !row.request_fingerprint_sha256 ||
          !isSendResult(row.result) || row.result.state !== 'queued') return [];
      return [{
        dispatchAttempt: row.dispatch_attempt,
        operation: {
          connectorId: row.connector_id,
          delivery: row.delivery,
          dispatchDelivery: row.dispatch_delivery,
          durableOperations: row.durable_operations,
          ...(row.expected_turn_id ? { expectedTurnId: row.expected_turn_id } : {}),
          fingerprint: row.fingerprint_sha256,
          generation,
          message: row.message,
          operationId: row.operation_id,
          queuedResult: row.result,
          requestFingerprint: row.request_fingerprint_sha256,
          threadId: row.thread_id,
          userId: row.owner_user_id
        },
        result: row.result,
        state: row.state === 'queued'
          ? 'queued' as const
          : row.state === 'uncertain' ? 'uncertain' as const : 'pending' as const
      }];
    });
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
    if (row.state === 'completed' && isLegacyStartResult(row.result)) {
      return {
        kind: 'attention',
        message: 'This pre-upgrade Codex task has no proven worker or initiating-task binding and will not be redispatched automatically.'
      };
    }
    if (row.state === 'completed' && isStartResult(row.result)) {
      return { kind: 'confirmed', result: row.result };
    }
    return row.state === 'uncertain' ? { kind: 'uncertain' } : { kind: 'pending' };
  }

  async releaseUncertainStart(input: {
    fingerprint: string;
    legacyFingerprint?: string;
    operationId: string;
    userId: string;
  }) {
    const run = async (client: DatabaseQueryClient) => {
      const current = await client.query<{
        association_key: string;
        fingerprint_sha256: string;
        state: string | null;
        start_payload: unknown;
        result: unknown;
      }>(
        `select o.association_key, o.fingerprint_sha256, s.state, s.start_payload, s.result
           from codex_machine_task_start_operations o
           join codex_machine_task_starts s
             on s.owner_user_id = o.owner_user_id and s.association_key = o.association_key
          where o.owner_user_id = $1 and o.operation_id = $2
          for update of o, s`,
        [input.userId, input.operationId]
      );
      const row = current.rows[0];
      if (!row) return 'missing' as const;
      const legacy = isLegacyStartPayload(row.start_payload) || isLegacyStartResult(row.result);
      if (row.fingerprint_sha256 !== input.fingerprint &&
          !(legacy && input.legacyFingerprint === row.fingerprint_sha256)) return 'conflict' as const;
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
      if (!row) return { kind: 'conflict' } as const;
      if (isLegacyStartPayload(row.start_payload) || isLegacyStartResult(row.result)) {
        return { kind: 'conflict' } as const;
      }
      if (!isStartPayload(row.start_payload)) return { kind: 'conflict' } as const;
      const startPayload = row.start_payload;
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
            startPayload
          } as const
        : {
            dispatchOperationId: row.dispatch_operation_id,
            durableOperations: row.durable_operations,
            generation, kind: 'pending',
            sameOperation: row.dispatch_operation_id === operation.operationId,
            startPayload
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
      const inserted = await client.query<{ operation_id: string }>(
        `insert into codex_machine_task_sends (
           owner_user_id, operation_id, connector_id, thread_id,
           connector_generation, durable_operations, fingerprint_sha256, state, result,
           delivery, dispatch_delivery, expected_turn_id, message, request_fingerprint_sha256
         ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9, $10, $11, $12, $13)
         on conflict do nothing
         returning operation_id`,
        [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
          operation.generation, operation.durableOperations, operation.fingerprint,
          operation.queuedResult ? JSON.stringify(operation.queuedResult) : null,
          operation.delivery, operation.dispatchDelivery, operation.expectedTurnId ?? null,
          operation.message, operation.requestFingerprint]
      );
      if (inserted.rows.length > 0) return { kind: 'new' } as const;
      const existing = await client.query<SendRow>(
        `select operation_id, connector_id, thread_id, connector_generation,
                durable_operations, fingerprint_sha256, state, result,
                delivery, dispatch_delivery, expected_turn_id, dispatch_attempt
           from codex_machine_task_sends
          where owner_user_id = $1 and (
            operation_id = $2 or (
              connector_id = $3 and thread_id = $4 and state in ('pending', 'queued', 'uncertain')
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
      if (isRecoverableQueuedRow(row)) {
        return {
          dispatchAttempt: row.dispatch_attempt,
          kind: 'queued',
          result: row.result,
          state: row.state
        } as const;
      }
      if (row.state === 'uncertain') {
        const generation = Number(row.connector_generation);
        return Number.isSafeInteger(generation) && generation > 0
          ? {
              dispatchDelivery: row.dispatch_delivery,
              durableOperations: row.durable_operations,
              ...(row.expected_turn_id ? { expectedTurnId: row.expected_turn_id } : {}),
              generation, kind: 'uncertain'
            } as const
          : { kind: 'fenced' } as const;
      }
      const generation = Number(row.connector_generation);
      return Number.isSafeInteger(generation) && generation > 0
        ? {
            dispatchDelivery: row.dispatch_delivery,
            durableOperations: row.durable_operations,
            ...(row.expected_turn_id ? { expectedTurnId: row.expected_turn_id } : {}),
            generation, kind: 'pending'
          } as const
        : { kind: 'fenced' } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async completeSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult
  ) {
    await this.transitionSend(operation, 'completed', result);
  }

  async markSendUncertain(operation: CodexMachineTaskSendOperation) {
    await this.transitionSend(operation, 'uncertain');
  }

  async queueSend(
    operation: CodexMachineTaskSendOperation,
    result: CodexMachineTaskSendResult
  ) {
    await this.transitionSend(operation, 'queued', result);
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

  async resumeQueuedSend(operation: CodexMachineTaskSendOperation) {
    const resumed = await this.client.query<{ dispatch_attempt: number }>(
      `update codex_machine_task_sends
          set state = 'pending', dispatch_attempt = dispatch_attempt + 1, updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state = 'queued'
        returning dispatch_attempt`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint]
    );
    return resumed.rows[0]?.dispatch_attempt;
  }

  async rebindQueuedSend(operation: CodexMachineTaskSendOperation, generation: number) {
    const rebound = await this.client.query<{ operation_id: string }>(
      `update codex_machine_task_sends
          set connector_generation = $7, updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state = 'queued'
        returning operation_id`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint, generation]
    );
    return rebound.rows.length === 1;
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
    state: 'completed' | 'queued' | 'uncertain',
    result?: CodexMachineTaskSendResult
  ) {
    const transitioned = await this.client.query<{ operation_id: string }>(
      `update codex_machine_task_sends
          set state = $7, result = $8::jsonb, updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state in ('pending', 'queued', 'uncertain')
        returning operation_id`,
      [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
        operation.generation, operation.fingerprint, state,
        result ? JSON.stringify(result) : null]
    );
    if (transitioned.rows.length !== 1) {
      throw new Error('Codex task send reservation was not updated.');
    }
  }
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

function isWorkerSelection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const worker = value as Record<string, unknown>;
  return typeof worker.model === 'string' && CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN.test(worker.model) &&
    typeof worker.reasoningEffort === 'string' && CODEX_MACHINE_TASK_WORKER_SELECTOR_PATTERN.test(worker.reasoningEffort);
}

function isLegacyStartResult(value: unknown) {
  if (!isStartResult(value) || value.state !== 'confirmed') return false;
  const task = (value as { task?: unknown }).task;
  return !task || typeof task !== 'object' || Array.isArray(task) ||
    !isWorkerSelection((task as Record<string, unknown>).worker);
}

function isBasicStartPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.branch !== 'string' || !/\S/.test(payload.branch) ||
    typeof payload.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(payload.commit)) return false;
  const issue = payload.issue;
  const repository = payload.repository;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue) ||
      !repository || typeof repository !== 'object' || Array.isArray(repository)) return false;
  const issueRecord = issue as Record<string, unknown>;
  const repositoryRecord = repository as Record<string, unknown>;
  return Number.isSafeInteger(issueRecord.number) && Number(issueRecord.number) > 0 &&
    typeof issueRecord.url === 'string' && /^https:\/\//.test(issueRecord.url) &&
    typeof repositoryRecord.id === 'string' && /\S/.test(repositoryRecord.id) &&
    typeof repositoryRecord.nameWithOwner === 'string' && /\S+\/\S+/.test(repositoryRecord.nameWithOwner);
}

function isLegacyStartPayload(value: unknown) {
  return isBasicStartPayload(value) && !isWorkerSelection((value as Record<string, unknown>).worker);
}

function isStartPayload(value: unknown): value is CodexMachineTaskStartPayload {
  if (!isBasicStartPayload(value)) return false;
  const payload = value as Record<string, unknown>;
  const worker = payload.worker as Record<string, unknown> | undefined;
  const reportingTask = payload.reportingTask as Record<string, unknown> | undefined;
  return isWorkerSelection(worker) &&
    (reportingTask === undefined || (
      (reportingTask.role === 'project-manager' || reportingTask.role === 'initiator') &&
      typeof reportingTask.threadId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportingTask.threadId)
    ));
}

function isSendResult(value: unknown): value is CodexMachineTaskSendResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.apiVersion === 1 && typeof result.operationId === 'string' &&
    typeof result.state === 'string' &&
    ['accepted', 'blocked', 'completed', 'queued', 'uncertain'].includes(result.state);
}

function isRecoverableQueuedRow(row: SendRow): row is SendRow & {
  result: Extract<CodexMachineTaskSendResult, { state: 'queued' }>;
  state: 'pending' | 'queued' | 'uncertain';
} {
  return (row.state === 'queued' ||
    (row.state === 'pending' || row.state === 'uncertain') &&
      row.delivery === 'queue') &&
    isSendResult(row.result) && row.result.state === 'queued';
}

function sendLookup(row: SendRow): CodexMachineTaskSendLookup {
  if (row.state === 'completed' && isSendResult(row.result)) {
    return { kind: 'replayed', result: row.result };
  }
  if (isRecoverableQueuedRow(row)) {
    return {
      dispatchAttempt: row.dispatch_attempt,
      kind: 'queued',
      result: row.result,
      state: row.state
    };
  }
  const generation = Number(row.connector_generation);
  if (!Number.isSafeInteger(generation) || generation < 1 ||
      row.state !== 'pending' && row.state !== 'uncertain') return { kind: 'conflict' };
  return {
    connectorId: row.connector_id,
    dispatchDelivery: row.dispatch_delivery,
    durableOperations: row.durable_operations,
    ...(row.expected_turn_id ? { expectedTurnId: row.expected_turn_id } : {}),
    generation,
    kind: 'reserved',
    state: row.state
  };
}
