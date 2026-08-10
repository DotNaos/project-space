import type {
  TaskExecutionOperationRecord,
  TaskExecutionOperationState
} from '../../src/shared/task-execution-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  ReserveTaskExecutionOperationInput,
  TaskExecutionOperationReservation,
  TaskExecutionOperationStore
} from './contracts';
import { assertSafeTaskExecutionResult, sameSafeResult } from './safe-result';

interface OperationRow {
  action: string;
  created_at: Date | string;
  execution_id: string | null;
  expires_at: Date | string;
  fingerprint_sha256: string;
  operation_id: string;
  result: unknown;
  state: TaskExecutionOperationState;
  updated_at: Date | string;
}

const columns = `
  operation_id, execution_id, action, fingerprint_sha256, state, result,
  created_at, updated_at, expires_at
`;
const terminalStates = new Set<TaskExecutionOperationState>(['blocked', 'completed']);
const retentionMs = 30 * 24 * 60 * 60 * 1_000;

export class PostgresTaskExecutionOperationStore implements TaskExecutionOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async claimDispatch(input: ReserveTaskExecutionOperationInput) {
    assertOperation(input);
    const result = await this.client.query<OperationRow>(
      `update execution_operations
          set state = 'dispatched', result = null, updated_at = now(),
              expires_at = now() + interval '30 days'
        where owner_user_id = $1 and operation_id = $2
          and action = $3 and fingerprint_sha256 = $4
          and execution_id is not distinct from $5::uuid
          and state in ('reserved', 'confirmed')
        returning ${columns}`,
      [
        input.ownerUserId, input.operationId, input.action, input.fingerprint,
        input.executionId ?? null
      ]
    );
    if (result.rows[0]) return 'claimed' as const;
    const current = await this.read(input.ownerUserId, input.operationId);
    if (!current || !sameOperationIdentity(current, input)) return 'conflict' as const;
    return 'in_progress' as const;
  }

  async reserve(
    input: ReserveTaskExecutionOperationInput
  ): Promise<TaskExecutionOperationReservation> {
    assertOperation(input);
    const run = async (client: DatabaseQueryClient): Promise<TaskExecutionOperationReservation> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `task-execution-operation:${input.ownerUserId}:${input.operationId}`
      ]);
      await client.query(
        `delete from execution_operations
          where (owner_user_id, operation_id) in (
            select owner_user_id, operation_id from execution_operations
             where state in ('completed', 'blocked') and expires_at <= now()
             order by expires_at limit 100
          )`
      );
      const existing = await readForUpdate(client, input.ownerUserId, input.operationId);
      if (existing) return reservationFor(existing, input);
      const inserted = await client.query<OperationRow>(
        `insert into execution_operations (
           owner_user_id, operation_id, execution_id, action, fingerprint_sha256,
           state, created_at, updated_at, expires_at
         ) values ($1, $2, $3::uuid, $4, $5, 'reserved', now(), now(), now() + interval '30 days')
         on conflict (owner_user_id, operation_id) do nothing
         returning ${columns}`,
        [
          input.ownerUserId, input.operationId, input.executionId ?? null,
          input.action, input.fingerprint
        ]
      );
      if (inserted.rows[0]) return { kind: 'new', operation: mapOperation(inserted.rows[0]) };
      const raced = await readForUpdate(client, input.ownerUserId, input.operationId);
      return raced ? reservationFor(raced, input) : { kind: 'conflict' };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async read(ownerUserId: string, operationId: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns} from execution_operations
        where owner_user_id = $1 and operation_id = $2
          and (state not in ('completed', 'blocked') or expires_at > now())`,
      [ownerUserId, operationId]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : undefined;
  }

  async transition(input: {
    action: string;
    executionId?: string;
    fingerprint: string;
    ownerUserId: string;
    operationId: string;
    state: Exclude<TaskExecutionOperationState, 'reserved'>;
    result?: Record<string, unknown>;
  }) {
    assertOperation(input);
    assertSafeTaskExecutionResult(input.result);
    assertTerminalResult(input.state, input.result);
    const allowed = allowedSourceStates(input.state);
    const result = await this.client.query<OperationRow>(
      `update execution_operations
          set state = $3, result = $4::jsonb, updated_at = now(),
              expires_at = now() + interval '30 days'
        where owner_user_id = $1 and operation_id = $2
          and action = $5 and fingerprint_sha256 = $6
          and execution_id is not distinct from $7::uuid
          and state = any($8::text[])
        returning ${columns}`,
      [
        input.ownerUserId, input.operationId, input.state,
        input.result ? JSON.stringify(input.result) : null, input.action,
        input.fingerprint, input.executionId ?? null, allowed
      ]
    );
    if (result.rows[0]) return mapOperation(result.rows[0]);
    const current = await this.read(input.ownerUserId, input.operationId);
    if (current && sameOperationIdentity(current, input) && current.state === input.state &&
        sameSafeResult(current.result, input.result)) return current;
    throw new Error('Task Execution operation was not updated.');
  }
}

interface MemoryOperation extends TaskExecutionOperationRecord {
  ownerUserId: string;
}

export class MemoryTaskExecutionOperationStore implements TaskExecutionOperationStore {
  private readonly operations = new Map<string, MemoryOperation>();

  constructor(private readonly now: () => number = Date.now) {}

  async claimDispatch(input: ReserveTaskExecutionOperationInput) {
    assertOperation(input);
    this.cleanup();
    const id = key(input.ownerUserId, input.operationId);
    const current = this.operations.get(id);
    if (!current || !sameOperationIdentity(current, input)) return 'conflict' as const;
    if (!['reserved', 'confirmed'].includes(current.state)) return 'in_progress' as const;
    const claimedAt = this.now();
    this.operations.set(id, {
      ...current,
      expiresAt: new Date(claimedAt + retentionMs).toISOString(),
      result: undefined,
      state: 'dispatched',
      updatedAt: new Date(claimedAt).toISOString()
    });
    return 'claimed' as const;
  }

  async reserve(
    input: ReserveTaskExecutionOperationInput
  ): Promise<TaskExecutionOperationReservation> {
    assertOperation(input);
    this.cleanup();
    const id = key(input.ownerUserId, input.operationId);
    const existing = this.operations.get(id);
    if (existing) return memoryReservation(existing, input);
    const now = new Date(this.now()).toISOString();
    const operation: MemoryOperation = {
      action: input.action,
      createdAt: now,
      ...(input.executionId ? { executionId: input.executionId } : {}),
      expiresAt: new Date(this.now() + retentionMs).toISOString(),
      fingerprint: input.fingerprint,
      operationId: input.operationId,
      ownerUserId: input.ownerUserId,
      state: 'reserved',
      updatedAt: now
    };
    this.operations.set(id, operation);
    return { kind: 'new', operation: publicOperation(operation) };
  }

  async read(ownerUserId: string, operationId: string) {
    this.cleanup();
    const operation = this.operations.get(key(ownerUserId, operationId));
    return operation ? publicOperation(operation) : undefined;
  }

  async transition(input: {
    action: string;
    executionId?: string;
    fingerprint: string;
    ownerUserId: string;
    operationId: string;
    state: Exclude<TaskExecutionOperationState, 'reserved'>;
    result?: Record<string, unknown>;
  }) {
    assertOperation(input);
    assertSafeTaskExecutionResult(input.result);
    assertTerminalResult(input.state, input.result);
    this.cleanup();
    const id = key(input.ownerUserId, input.operationId);
    const current = this.operations.get(id);
    if (!current) throw new Error('Task Execution operation was not found.');
    if (!sameOperationIdentity(current, input)) {
      throw new Error('Task Execution operation identity does not match.');
    }
    if (current.state === input.state && sameSafeResult(current.result, input.result)) {
      return publicOperation(current);
    }
    if (!allowedSourceStates(input.state).includes(current.state)) {
      throw new Error('Task Execution operation was not updated.');
    }
    const transitionedAt = this.now();
    const updatedAt = new Date(transitionedAt).toISOString();
    const updated: MemoryOperation = {
      ...current,
      ...(input.result ? { result: structuredClone(input.result) } : { result: undefined }),
      expiresAt: new Date(transitionedAt + retentionMs).toISOString(),
      state: input.state,
      updatedAt
    };
    this.operations.set(id, updated);
    return publicOperation(updated);
  }

  private cleanup() {
    const now = this.now();
    for (const [id, operation] of this.operations) {
      if (terminalStates.has(operation.state) && Date.parse(operation.expiresAt) <= now) {
        this.operations.delete(id);
      }
    }
  }
}

function reservationFor(
  row: OperationRow,
  input: ReserveTaskExecutionOperationInput
): TaskExecutionOperationReservation {
  return memoryReservation(mapOperation(row), input);
}

function memoryReservation(
  operation: TaskExecutionOperationRecord,
  input: ReserveTaskExecutionOperationInput
): TaskExecutionOperationReservation {
  if (operation.action !== input.action || operation.executionId !== input.executionId ||
      operation.fingerprint !== input.fingerprint) return { kind: 'conflict' };
  return terminalStates.has(operation.state)
    ? { kind: 'replayed', operation: structuredClone(operation) }
    : { kind: 'in_progress', operation: structuredClone(operation) };
}

async function readForUpdate(
  client: DatabaseQueryClient,
  ownerUserId: string,
  operationId: string
) {
  const result = await client.query<OperationRow>(
    `select ${columns} from execution_operations
      where owner_user_id = $1 and operation_id = $2 for update`,
    [ownerUserId, operationId]
  );
  return result.rows[0];
}

function mapOperation(row: OperationRow): TaskExecutionOperationRecord {
  const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result)
    ? structuredClone(row.result as Record<string, unknown>)
    : undefined;
  assertSafeTaskExecutionResult(result);
  return {
    action: row.action,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    expiresAt: new Date(row.expires_at).toISOString(),
    fingerprint: row.fingerprint_sha256,
    operationId: row.operation_id,
    ...(result ? { result } : {}),
    state: row.state,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function sameOperationIdentity(
  operation: TaskExecutionOperationRecord,
  input: ReserveTaskExecutionOperationInput
) {
  return operation.action === input.action && operation.executionId === input.executionId &&
    operation.fingerprint === input.fingerprint;
}

function publicOperation(operation: MemoryOperation) {
  const { ownerUserId: _, ...record } = operation;
  return structuredClone(record);
}

function allowedSourceStates(target: Exclude<TaskExecutionOperationState, 'reserved'>) {
  if (target === 'dispatched') return ['reserved'] as TaskExecutionOperationState[];
  if (target === 'confirmed') return ['dispatched', 'uncertain'] as TaskExecutionOperationState[];
  if (target === 'uncertain') return ['reserved', 'dispatched', 'confirmed', 'uncertain'] as TaskExecutionOperationState[];
  return ['reserved', 'dispatched', 'confirmed', 'uncertain'] as TaskExecutionOperationState[];
}

function assertTerminalResult(
  state: Exclude<TaskExecutionOperationState, 'reserved'>,
  result: Record<string, unknown> | undefined
) {
  if ((state === 'completed' || state === 'blocked') && !result) {
    throw new Error('Terminal Task Execution operation requires a result.');
  }
}

function assertOperation(input: ReserveTaskExecutionOperationInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.operationId) ||
      !/^[0-9a-f]{64}$/.test(input.fingerprint) || !input.action.trim() ||
      input.action.length > 80) throw new Error('Task Execution operation is invalid.');
}

function key(ownerUserId: string, operationId: string) {
  return `${ownerUserId}\0${operationId}`;
}
