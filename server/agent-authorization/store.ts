import type { DatabaseQueryClient } from '../database/client';
import type {
  AgentAuthorizationOperation,
  AgentAuthorizationOperationRecord,
  AgentAuthorizationOperationState,
  AgentAuthorizationOperationStore,
  AgentAuthorizationReservation,
  AgentAuthorizationTerminalState
} from './contracts';

export type {
  AgentAuthorizationOperation,
  AgentAuthorizationOperationRecord,
  AgentAuthorizationOperationState,
  AgentAuthorizationOperationStore,
  AgentAuthorizationReservation,
  AgentAuthorizationTerminalState
} from './contracts';

interface OperationRow {
  agent_kind: string;
  connector_generation: number | string | null;
  connector_id: string | null;
  deadline_at: Date | string | null;
  dispatch_attempted: boolean;
  environment_id: string;
  fingerprint_sha256: string;
  operation_id: string;
  owner_user_id: string;
  state: AgentAuthorizationOperationState;
}

const columns = `
  owner_user_id, operation_id, environment_id, agent_kind, fingerprint_sha256,
  connector_id, connector_generation, state, dispatch_attempted, deadline_at
`;

const terminalStates = new Set<AgentAuthorizationOperationState>([
  'cancelled', 'expired', 'failed', 'ready'
]);

export class PostgresAgentAuthorizationOperationStore
implements AgentAuthorizationOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async reserve(input: AgentAuthorizationOperation) {
    const run = async (client: DatabaseQueryClient): Promise<AgentAuthorizationReservation> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [scopeKey(input)]);
      await client.query(
        `delete from agent_authorization_operations as expired
          using (
            select owner_user_id, operation_id
              from agent_authorization_operations
             where expires_at <= now()
             order by expires_at
             limit 100
          ) as stale
          where expired.owner_user_id = stale.owner_user_id
            and expired.operation_id = stale.operation_id`
      );
      const existing = await this.readForUpdate(client, input.userId, input.operationId);
      if (existing) return this.existingReservation(client, input, existing);

      const active = await client.query<{ operation_id: string }>(
        `select operation_id
           from agent_authorization_operations
          where owner_user_id = $1 and environment_id = $2::uuid and agent_kind = $3
            and (
              state in ('dispatching', 'pending')
              or (state = 'ambiguous' and dispatch_attempted)
            )
          limit 1`,
        [input.userId, input.environmentId, input.agentKind]
      );
      if (active.rows.length > 0) return { kind: 'fenced' };

      const inserted = await client.query<{ operation_id: string }>(
        `insert into agent_authorization_operations (
           owner_user_id, operation_id, environment_id, agent_kind, fingerprint_sha256,
           connector_id, connector_generation, state
         ) values ($1, $2, $3::uuid, $4, $5, $6, $7, 'dispatching')
         on conflict (owner_user_id, operation_id) do nothing
         returning operation_id`,
        [
          input.userId, input.operationId, input.environmentId, input.agentKind,
          input.fingerprint, input.connectorId ?? null, input.connectorGeneration ?? null
        ]
      );
      if (inserted.rows.length > 0) return { kind: 'new' };
      const raced = await this.readForUpdate(client, input.userId, input.operationId);
      return raced
        ? this.existingReservation(client, input, raced)
        : { kind: 'conflict' };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async read(userId: string, operationId: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns}
         from agent_authorization_operations
        where owner_user_id = $1 and operation_id = $2 and expires_at > now()`,
      [userId, operationId]
    );
    return result.rows[0] ? mapRecord(result.rows[0]) : undefined;
  }

  async markPending(input: AgentAuthorizationOperation, deadlineAt: string) {
    await this.transition(input, 'pending', true, deadlineAt, ['dispatching']);
  }

  async markAmbiguous(
    input: AgentAuthorizationOperation,
    dispatchAttempted = true,
    deadlineAt?: string
  ) {
    await this.transition(
      input,
      'ambiguous',
      dispatchAttempted,
      deadlineAt,
      ['dispatching', 'pending', 'ambiguous']
    );
  }

  async markRetryable(input: AgentAuthorizationOperation) {
    await this.transition(input, 'retryable', false, undefined, [
      'dispatching', 'pending', 'ambiguous'
    ]);
  }

  async complete(input: AgentAuthorizationOperation, state: AgentAuthorizationTerminalState) {
    await this.transition(
      input,
      state,
      false,
      undefined,
      ['dispatching', 'pending', 'ambiguous']
    );
  }

  private async readForUpdate(
    client: DatabaseQueryClient,
    userId: string,
    operationId: string
  ) {
    const result = await client.query<OperationRow>(
      `select ${columns}
         from agent_authorization_operations
        where owner_user_id = $1 and operation_id = $2 and expires_at > now()
        for update`,
      [userId, operationId]
    );
    return result.rows[0];
  }

  private async existingReservation(
    client: DatabaseQueryClient,
    input: AgentAuthorizationOperation,
    row: OperationRow
  ): Promise<AgentAuthorizationReservation> {
    const record = mapRecord(row);
    if (!sameOperation(record, input)) return { kind: 'conflict' };
    if (terminalStates.has(record.state)) return { kind: 'replayed', record };
    if (record.state === 'retryable') {
      const active = await client.query<{ operation_id: string }>(
        `select operation_id
           from agent_authorization_operations
          where owner_user_id = $1 and environment_id = $2::uuid and agent_kind = $3
            and operation_id <> $4
            and (
              state in ('dispatching', 'pending')
              or (state = 'ambiguous' and dispatch_attempted)
            )
          limit 1`,
        [input.userId, input.environmentId, input.agentKind, input.operationId]
      );
      if (active.rows.length > 0) return { kind: 'fenced' };
      await client.query(
        `update agent_authorization_operations
            set state = 'dispatching', dispatch_attempted = false, deadline_at = null,
                connector_id = $3, connector_generation = $4, updated_at = now(),
                expires_at = now() + interval '30 days'
          where owner_user_id = $1 and operation_id = $2 and state = 'retryable'`,
        [input.userId, input.operationId, input.connectorId ?? null, input.connectorGeneration ?? null]
      );
      return { kind: 'new' };
    }
    if (record.state === 'pending') return { kind: 'pending', record };
    if (record.state === 'ambiguous') return { kind: 'ambiguous', record };
    return { kind: 'in_progress', record };
  }

  private async transition(
    input: AgentAuthorizationOperation,
    state: Exclude<AgentAuthorizationOperationState, 'dispatching'>,
    dispatchAttempted: boolean,
    deadlineAt: string | undefined,
    sourceStates: readonly AgentAuthorizationOperationState[]
  ) {
    const updated = await this.client.query<{ operation_id: string }>(
      `update agent_authorization_operations
          set state = $6, dispatch_attempted = $7,
              deadline_at = coalesce($8::timestamptz, deadline_at),
              updated_at = now(), expires_at = now() + interval '30 days'
        where owner_user_id = $1 and operation_id = $2 and environment_id = $3::uuid
          and agent_kind = $4 and fingerprint_sha256 = $5
          and state = any($9::text[])
        returning operation_id`,
      [
        input.userId, input.operationId, input.environmentId, input.agentKind,
        input.fingerprint, state, dispatchAttempted, deadlineAt ?? null, sourceStates
      ]
    );
    if (updated.rows.length !== 1) {
      const current = await this.read(input.userId, input.operationId);
      if (current && sameOperation(current, input) && current.state === state) return;
      throw new Error('Agent authorization operation was not updated.');
    }
  }
}

interface MemoryRecord extends AgentAuthorizationOperationRecord {
  expiresAt: number;
}

export class MemoryAgentAuthorizationOperationStore
implements AgentAuthorizationOperationStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  async reserve(input: AgentAuthorizationOperation): Promise<AgentAuthorizationReservation> {
    this.cleanup();
    const key = operationKey(input.userId, input.operationId);
    const existing = this.records.get(key);
    if (existing) return this.existingReservation(existing, input);
    const active = [...this.records.values()].some((record) => (
      record.userId === input.userId && record.environmentId === input.environmentId &&
      record.agentKind === input.agentKind && (
        record.state === 'dispatching' || record.state === 'pending' ||
        (record.state === 'ambiguous' && record.dispatchAttempted)
      )
    ));
    if (active) return { kind: 'fenced' };
    this.records.set(key, {
      ...structuredClone(input),
      dispatchAttempted: false,
      expiresAt: this.now() + retentionMs,
      state: 'dispatching'
    });
    return { kind: 'new' };
  }

  async read(userId: string, operationId: string) {
    this.cleanup();
    const record = this.records.get(operationKey(userId, operationId));
    return record ? publicRecord(record) : undefined;
  }

  async markPending(input: AgentAuthorizationOperation, deadlineAt: string) {
    this.transition(input, 'pending', true, deadlineAt, ['dispatching']);
  }

  async markAmbiguous(
    input: AgentAuthorizationOperation,
    dispatchAttempted = true,
    deadlineAt?: string
  ) {
    this.transition(
      input,
      'ambiguous',
      dispatchAttempted,
      deadlineAt,
      ['dispatching', 'pending', 'ambiguous']
    );
  }

  async markRetryable(input: AgentAuthorizationOperation) {
    this.transition(input, 'retryable', false, undefined, [
      'dispatching', 'pending', 'ambiguous'
    ]);
  }

  async complete(input: AgentAuthorizationOperation, state: AgentAuthorizationTerminalState) {
    this.transition(input, state, false, undefined, ['dispatching', 'pending', 'ambiguous']);
  }

  private existingReservation(
    record: MemoryRecord,
    input: AgentAuthorizationOperation
  ): AgentAuthorizationReservation {
    if (!sameOperation(record, input)) return { kind: 'conflict' };
    if (terminalStates.has(record.state)) return { kind: 'replayed', record: publicRecord(record) };
    if (record.state === 'retryable') {
      const active = [...this.records.values()].some((candidate) => (
        candidate.userId === input.userId && candidate.environmentId === input.environmentId &&
        candidate.agentKind === input.agentKind && candidate.operationId !== input.operationId && (
          candidate.state === 'dispatching' || candidate.state === 'pending' ||
          (candidate.state === 'ambiguous' && candidate.dispatchAttempted)
        )
      ));
      if (active) return { kind: 'fenced' };
      record.connectorId = input.connectorId;
      record.connectorGeneration = input.connectorGeneration;
      record.deadlineAt = undefined;
      record.dispatchAttempted = false;
      record.expiresAt = this.now() + retentionMs;
      record.state = 'dispatching';
      return { kind: 'new' };
    }
    if (record.state === 'pending') return { kind: 'pending', record: publicRecord(record) };
    if (record.state === 'ambiguous') return { kind: 'ambiguous', record: publicRecord(record) };
    return { kind: 'in_progress', record: publicRecord(record) };
  }

  private transition(
    input: AgentAuthorizationOperation,
    state: Exclude<AgentAuthorizationOperationState, 'dispatching'>,
    dispatchAttempted: boolean,
    deadlineAt: string | undefined,
    sourceStates: readonly AgentAuthorizationOperationState[]
  ) {
    const record = this.records.get(operationKey(input.userId, input.operationId));
    if (record && sameOperation(record, input) && record.state === state) return;
    if (!record || !sameOperation(record, input) || !sourceStates.includes(record.state)) {
      throw new Error('Agent authorization operation was not updated.');
    }
    record.deadlineAt = deadlineAt ?? record.deadlineAt;
    record.dispatchAttempted = dispatchAttempted;
    record.expiresAt = this.now() + retentionMs;
    record.state = state;
  }

  private cleanup() {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }
}

const retentionMs = 30 * 24 * 60 * 60_000;

function scopeKey(input: AgentAuthorizationOperation) {
  return `agent-authorization:${input.userId}:${input.environmentId}:${input.agentKind}`;
}

function operationKey(userId: string, operationId: string) {
  return `${userId}\0${operationId}`;
}

function sameOperation(
  left: AgentAuthorizationOperation,
  right: AgentAuthorizationOperation
) {
  return left.userId === right.userId && left.operationId === right.operationId &&
    left.environmentId === right.environmentId && left.agentKind === right.agentKind &&
    left.fingerprint === right.fingerprint;
}

function mapRecord(row: OperationRow): AgentAuthorizationOperationRecord {
  const connectorGeneration = row.connector_generation === null
    ? undefined
    : Number(row.connector_generation);
  if (connectorGeneration !== undefined &&
      (!Number.isSafeInteger(connectorGeneration) || connectorGeneration < 1)) {
    throw new Error('Agent authorization connector generation is invalid.');
  }
  return {
    agentKind: row.agent_kind,
    connectorGeneration,
    connectorId: row.connector_id ?? undefined,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : undefined,
    dispatchAttempted: row.dispatch_attempted,
    environmentId: row.environment_id,
    fingerprint: row.fingerprint_sha256,
    operationId: row.operation_id,
    state: row.state,
    userId: row.owner_user_id
  };
}

function publicRecord(record: MemoryRecord): AgentAuthorizationOperationRecord {
  const { expiresAt: _, ...value } = record;
  return structuredClone(value);
}
