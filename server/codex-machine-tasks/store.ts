import type {
  CodexMachineTaskSendResult,
  CodexMachineTaskStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  CodexMachineTaskStartOperation,
  CodexMachineTaskStartPayload,
  CodexMachineTaskSendOperation,
  CodexMachineTasksStore
} from './service';

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
  durable_operations: boolean;
  fingerprint_sha256: string;
  operation_id: string;
  result: unknown;
  state: 'completed' | 'pending' | 'uncertain';
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

  async reserveStart(operation: CodexMachineTaskStartOperation) {
    const run = async (client: DatabaseQueryClient) => {
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
        `select dispatch_operation_id, connector_generation, durable_operations, state, result
           from codex_machine_task_starts
          where owner_user_id = $1 and association_key = $2
          for update`,
        [operation.userId, operation.associationKey]
      );
      const row = existing.rows[0];
      if (!row) return {
        durableOperations: operation.durableOperations,
        generation: operation.generation, kind: 'pending', sameOperation: false
      } as const;
      if (insertedAssociation.rows.length > 0 && insertedOperation.rows.length > 0) {
        return { kind: 'new' } as const;
      }
      if (row.state === 'completed' && isStartResult(row.result)) {
        return { kind: 'replayed', result: row.result } as const;
      }
      const generation = Number(row.connector_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        return {
          durableOperations: operation.durableOperations,
          generation: operation.generation,
          kind: 'pending',
          sameOperation: false
        } as const;
      }
      return row.state === 'uncertain'
        ? {
            durableOperations: row.durable_operations,
            generation, kind: 'uncertain',
            sameOperation: row.dispatch_operation_id === operation.operationId
          } as const
        : {
            durableOperations: row.durable_operations,
            generation, kind: 'pending',
            sameOperation: row.dispatch_operation_id === operation.operationId
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
      const inserted = await client.query<{ operation_id: string }>(
        `insert into codex_machine_task_sends (
           owner_user_id, operation_id, connector_id, thread_id,
           connector_generation, durable_operations, fingerprint_sha256, state
         ) values ($1, $2, $3, $4, $5, $6, $7, 'pending')
         on conflict do nothing
         returning operation_id`,
        [operation.userId, operation.operationId, operation.connectorId, operation.threadId,
          operation.generation, operation.durableOperations, operation.fingerprint]
      );
      if (inserted.rows.length > 0) return { kind: 'new' } as const;
      const existing = await client.query<SendRow>(
        `select operation_id, connector_id, thread_id, connector_generation,
                durable_operations, fingerprint_sha256, state, result
           from codex_machine_task_sends
          where owner_user_id = $1 and (
            operation_id = $2 or (
              connector_id = $3 and thread_id = $4 and state in ('pending', 'uncertain')
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
      if (row.state === 'uncertain') {
        const generation = Number(row.connector_generation);
        return Number.isSafeInteger(generation) && generation > 0
          ? { durableOperations: row.durable_operations, generation, kind: 'uncertain' } as const
          : { kind: 'fenced' } as const;
      }
      const generation = Number(row.connector_generation);
      return Number.isSafeInteger(generation) && generation > 0
        ? { durableOperations: row.durable_operations, generation, kind: 'pending' } as const
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
    result?: CodexMachineTaskSendResult
  ) {
    const transitioned = await this.client.query<{ operation_id: string }>(
      `update codex_machine_task_sends
          set state = $7, result = $8::jsonb, updated_at = now()
        where owner_user_id = $1 and operation_id = $2 and connector_id = $3
          and thread_id = $4 and connector_generation = $5
          and fingerprint_sha256 = $6 and state in ('pending', 'uncertain')
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
    ['accepted', 'blocked', 'completed', 'uncertain'].includes(result.state);
}
