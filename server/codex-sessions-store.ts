import { createHash } from 'node:crypto';

import type { DatabaseQueryClient } from './database/client';
import type {
  CodexSessionOperationResult,
  CodexSessionRecord,
  CodexSessionStreamEvent
} from '../src/shared/codex-sessions-api';
import { canonicalJson } from './codex-sessions/canonical-json';

export type CodexStoredOperationName =
  | 'approval'
  | 'continue'
  | 'input'
  | 'interrupt'
  | 'resume'
  | 'turn-start';

export interface CodexStoredOperationInput {
  fingerprint: unknown;
  machineId: string;
  operation: CodexStoredOperationName;
  operationId: string;
  threadId: string;
  userId: string;
}

export type CodexStoredOperationReservation =
  | { kind: 'new' }
  | { kind: 'conflict' }
  | { kind: 'pending' }
  | { kind: 'ambiguous' }
  | { kind: 'replayed'; result: CodexSessionOperationResult };

interface SnapshotRow {
  snapshot: unknown;
}

interface OperationRow {
  fingerprint_sha256: string;
  result: unknown;
  state: 'ambiguous' | 'completed' | 'pending' | 'rejected';
}

interface EventRow {
  payload: unknown;
  sequence: number | string;
}

export class CodexSessionsStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async saveInventory(input: {
    checkedAt: string;
    completeInventory: boolean;
    machineId: string;
    sessions: CodexSessionRecord[];
    userId: string;
  }) {
    const run = async (client: DatabaseQueryClient) => {
      for (const session of input.sessions) {
        await client.query(
          `insert into codex_session_snapshots (
             owner_user_id, machine_id, thread_id, snapshot, archived,
             loaded_by_project_space, status, last_activity_at, checked_at, updated_at
           ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::timestamptz, $9::timestamptz)
           on conflict (owner_user_id, machine_id, thread_id) do update set
             snapshot = excluded.snapshot,
             archived = excluded.archived,
             loaded_by_project_space = excluded.loaded_by_project_space,
             status = excluded.status,
             last_activity_at = excluded.last_activity_at,
             checked_at = excluded.checked_at,
             updated_at = excluded.updated_at
           where codex_session_snapshots.checked_at <= excluded.checked_at`,
          [
            input.userId,
            input.machineId,
            session.id,
            JSON.stringify(session),
            session.archived,
            session.loadedByProjectSpace,
            session.status,
            session.lastActivityAt,
            input.checkedAt
          ]
        );
      }
      if (input.completeInventory) {
        await client.query(
          `update codex_session_snapshots
              set status = 'missing',
                  loaded_by_project_space = false,
                  snapshot = jsonb_set(
                    jsonb_set(snapshot, '{status}', '"missing"'::jsonb),
                    '{loadedByProjectSpace}', 'false'::jsonb
                  ),
                  checked_at = $3::timestamptz,
                  updated_at = $3::timestamptz
            where owner_user_id = $1
              and machine_id = $2
              and checked_at < $3::timestamptz
              and not (thread_id = any($4::text[]))`,
          [input.userId, input.machineId, input.checkedAt, input.sessions.map((session) => session.id)]
        );
      }
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async listInventory(userId: string, machineId: string): Promise<CodexSessionRecord[]> {
    const result = await this.client.query<SnapshotRow>(
      `select snapshot
         from codex_session_snapshots
        where owner_user_id = $1 and machine_id = $2
        order by last_activity_at desc, thread_id`,
      [userId, machineId]
    );
    return result.rows.flatMap((row) => isSessionRecord(row.snapshot) ? [row.snapshot] : []);
  }

  async reserveOperation(input: CodexStoredOperationInput): Promise<CodexStoredOperationReservation> {
    const fingerprint = operationFingerprint(input.fingerprint);
    const run = async (client: DatabaseQueryClient) => {
      const inserted = await client.query<{ operation_id: string }>(
        `insert into codex_session_operations (
           owner_user_id, machine_id, thread_id, operation_id, operation,
           fingerprint_sha256, state, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, 'pending', now(), now())
         on conflict (owner_user_id, machine_id, thread_id, operation_id) do nothing
         returning operation_id`,
        [
          input.userId,
          input.machineId,
          input.threadId,
          input.operationId,
          input.operation,
          fingerprint
        ]
      );
      if (inserted.rows.length > 0) return { kind: 'new' } as const;
      const existing = await client.query<OperationRow>(
        `select fingerprint_sha256, state, result
           from codex_session_operations
          where owner_user_id = $1 and machine_id = $2 and thread_id = $3 and operation_id = $4
          for update`,
        [input.userId, input.machineId, input.threadId, input.operationId]
      );
      const row = existing.rows[0];
      if (!row || row.fingerprint_sha256 !== fingerprint) return { kind: 'conflict' } as const;
      if (row.state === 'completed' && isOperationResult(row.result)) {
        return { kind: 'replayed', result: { ...row.result, replayed: true } } as const;
      }
      if (row.state === 'ambiguous') return { kind: 'ambiguous' } as const;
      return { kind: 'pending' } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async completeOperation(input: CodexStoredOperationInput, result: CodexSessionOperationResult) {
    return this.transitionOperation(input, 'completed', result);
  }

  async markOperationAmbiguous(input: CodexStoredOperationInput) {
    return this.transitionOperation(input, 'ambiguous');
  }

  async markStalePendingAmbiguous(before: string) {
    await this.client.query(
      `update codex_session_operations
          set state = 'ambiguous', updated_at = now()
        where state = 'pending' and updated_at < $1::timestamptz`,
      [before]
    );
  }

  async appendEvent(input: {
    event: CodexSessionStreamEvent;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const result = await this.client.query<{ sequence: number | string }>(
      `with inserted as (
         insert into codex_session_events (
           owner_user_id, machine_id, thread_id, event_id, payload
         ) values ($1, $2, $3, $4, $5::jsonb)
         on conflict (owner_user_id, machine_id, thread_id, event_id) do nothing
         returning sequence
       )
       select sequence from inserted
       union all
       select sequence from codex_session_events
        where owner_user_id = $1 and machine_id = $2 and thread_id = $3 and event_id = $4
       limit 1`,
      [input.userId, input.machineId, input.threadId, input.event.eventId, JSON.stringify(input.event)]
    );
    const sequence = Number(result.rows[0]?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('Could not persist the Codex session event.');
    }
    return sequence;
  }

  async listEvents(input: {
    afterSequence?: number;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const result = await this.client.query<EventRow>(
      `select sequence, payload
         from codex_session_events
        where owner_user_id = $1 and machine_id = $2 and thread_id = $3
          and sequence > $4 and expires_at > now()
        order by sequence
        limit 500`,
      [input.userId, input.machineId, input.threadId, input.afterSequence ?? 0]
    );
    return result.rows.flatMap((row) => isStreamEvent(row.payload)
      ? [{ event: row.payload, sequence: Number(row.sequence) }]
      : []);
  }

  async latestEventSequence(input: {
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const result = await this.client.query<{ sequence: number | string }>(
      `select coalesce(max(sequence), 0) as sequence
         from codex_session_events
        where owner_user_id = $1 and machine_id = $2 and thread_id = $3`,
      [input.userId, input.machineId, input.threadId]
    );
    const sequence = Number(result.rows[0]?.sequence ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Could not read the Codex session event cursor.');
    }
    return sequence;
  }

  async purgeExpiredEvents() {
    await this.client.query('delete from codex_session_events where expires_at <= now()');
  }

  private async transitionOperation(
    input: CodexStoredOperationInput,
    state: 'ambiguous' | 'completed',
    result?: CodexSessionOperationResult
  ) {
    await this.client.query(
      `update codex_session_operations
          set state = $6,
              result = $7::jsonb,
              updated_at = now()
        where owner_user_id = $1 and machine_id = $2 and thread_id = $3 and operation_id = $4
          and fingerprint_sha256 = $5 and state = 'pending'`,
      [
        input.userId,
        input.machineId,
        input.threadId,
        input.operationId,
        operationFingerprint(input.fingerprint),
        state,
        result ? JSON.stringify(result) : null
      ]
    );
  }
}

export function operationFingerprint(input: unknown) {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function isSessionRecord(value: unknown): value is CodexSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexSessionRecord>;
  return typeof record.id === 'string' && typeof record.machineId === 'string' &&
    typeof record.machineName === 'string' && typeof record.title === 'string' &&
    typeof record.lastActivityAt === 'string' && typeof record.archived === 'boolean' &&
    typeof record.loadedByProjectSpace === 'boolean' && isSessionStatus(record.status) &&
    optionalString(record.cwd) && optionalString(record.model) &&
    optionalString(record.modelProvider) && optionalString(record.project) &&
    optionalString(record.source);
}

function isOperationResult(value: unknown): value is CodexSessionOperationResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexSessionOperationResult>;
  return typeof record.operationId === 'string' && typeof record.threadId === 'string' &&
    typeof record.replayed === 'boolean' && typeof record.status === 'string' &&
    ['accepted', 'ambiguous', 'completed', 'rejected'].includes(record.status) &&
    optionalString(record.turnId);
}

function isStreamEvent(value: unknown): value is CodexSessionStreamEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CodexSessionStreamEvent>;
  if (typeof record.eventId !== 'string' || typeof record.type !== 'string') return false;
  switch (record.type) {
    case 'item': return Boolean(record.item) && typeof record.item?.id === 'string';
    case 'agent-message-delta': return typeof record.itemId === 'string' && typeof record.delta === 'string';
    case 'session-status': return typeof record.status === 'string' && [
      'active', 'archived', 'idle', 'missing', 'offline', 'unavailable'
    ].includes(record.status);
    case 'approval-requested': return typeof record.requestId === 'string';
    case 'user-input-requested': return typeof record.requestId === 'string' && Array.isArray(record.questions);
    case 'turn-completed': return typeof record.turnId === 'string' && optionalString(record.reason);
    default: return false;
  }
}

function isSessionStatus(value: unknown): value is CodexSessionRecord['status'] {
  return typeof value === 'string' && [
    'active', 'archived', 'idle', 'missing', 'offline', 'unavailable'
  ].includes(value);
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === 'string';
}
