import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import type {
  CanonicalRuntimeControlOperationIdentity,
  CanonicalRuntimeControlOperationState
} from '../server/canonical-runtime-control/operation-store-contracts';
import { PostgresCanonicalRuntimeControlOperationStore } from
  '../server/canonical-runtime-control/postgres-operation-store';
import { validateSafeResult } from
  '../server/canonical-runtime-control/operation-store-validation';

const environmentId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const generation = '30000000-0000-4000-8000-000000000003';
const sessionId = '40000000-0000-4000-8000-000000000004';
const identity: CanonicalRuntimeControlOperationIdentity = {
  actorId: 'agent-nora',
  actorKind: 'agent',
  actorUserId: 'owner-one',
  compatibilityAlias: false,
  environmentId,
  generation,
  operation: 'git.status',
  operationId: 'inspect-one',
  ownerUserId: 'owner-one',
  sessionId,
  targetIdentityRevision: '1:revision_one',
  workspaceId
};
const reservation = {
  fingerprint: 'a'.repeat(64),
  identity,
  reservedAt: '2026-08-12T10:00:00.000Z',
  reservedUntil: '2026-08-12T10:00:30.000Z'
};

describe('Postgres canonical Runtime control operation store', () => {
  test('requires transactions for atomic owner-scoped reservations', () => {
    const client: DatabaseQueryClient = { async query<Row>() { return { rows: [] as Row[] }; } };
    expect(() => new PostgresCanonicalRuntimeControlOperationStore(client)).toThrow(
      'Canonical Runtime control operations require database transactions.'
    );
  });

  test('reserves the full actor and immutable Runtime target binding', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = transactionalClient(async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('insert into canonical_runtime_control_operations')) {
        return { rows: [operationRow()] as Row[] };
      }
      return { rows: [] as Row[] };
    });

    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).reserve(reservation))
      .resolves.toMatchObject({
        kind: 'new',
        record: { fingerprint: reservation.fingerprint, identity, state: 'reserved' }
      });
    expect(calls[0]?.values).toEqual([
      'canonical-runtime-control-operation:owner-one:inspect-one'
    ]);
    const insert = calls.find(({ sql }) => sql.includes('insert into canonical_runtime_control_operations'));
    expect(insert?.values).toEqual([
      'owner-one', 'inspect-one', 'a'.repeat(64), 'owner-one', 'agent-nora', 'agent', false,
      'git.status', null, environmentId, '1:revision_one', workspaceId, generation, sessionId,
      reservation.reservedUntil, reservation.reservedAt
    ]);
  });

  test('atomically allocates a generation command sequence before dispatch', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = transactionalClient(async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('for update')) return { rows: [operationRow()] as Row[] };
      if (sql.includes('update workspace_runtime_generations')) {
        return { rows: [{ command_sequence: '12' }] as Row[] };
      }
      if (sql.includes("set state = 'dispatching'")) {
        return { rows: [operationRow({
          command_id: 'command-one', command_sequence: '12',
          dispatch_lease_until: '2026-08-12T10:00:31.000Z', reserved_until: null,
          state: 'dispatching'
        })] as Row[] };
      }
      return { rows: [] as Row[] };
    });
    const store = new PostgresCanonicalRuntimeControlOperationStore(client);
    await expect(store.markDispatchAttempted({
      commandId: 'command-one',
      dispatchedAt: '2026-08-12T10:00:01.000Z',
      dispatchedUntil: '2026-08-12T10:00:31.000Z',
      fingerprint: reservation.fingerprint,
      identity
    })).resolves.toMatchObject({
      command: { commandId: 'command-one', commandSequence: 12 }, state: 'dispatching'
    });
    expect(calls[1]?.values).toEqual([
      `canonical-runtime-control-generation:owner-one:${workspaceId}:${generation}`
    ]);
    const cursor = calls.find(({ sql }) => sql.includes('update workspace_runtime_generations'));
    expect(cursor?.sql).toContain('current_session_id = $5::uuid');
    expect(cursor?.values.slice(0, 5)).toEqual([
      'owner-one', workspaceId, environmentId, generation, sessionId
    ]);
    expect(calls.findIndex(({ sql }) => sql.includes('update workspace_runtime_generations')))
      .toBeLessThan(calls.findIndex(({ sql }) => sql.includes("set state = 'dispatching'")));
  });

  test('turns an expired dispatched operation uncertain instead of reserving it again', async () => {
    const client = transactionalClient(async <Row>(sql: string) => {
      if (sql.includes('for update')) return { rows: [operationRow({
        command_id: 'command-one', command_sequence: '1',
        dispatch_lease_until: '2026-08-12T09:59:59.000Z', reserved_until: null,
        state: 'dispatching'
      })] as Row[] };
      if (sql.includes("set state = 'uncertain'")) return { rows: [operationRow({
        command_id: 'command-one', command_sequence: '1', completed_at: reservation.reservedAt,
        dispatch_lease_until: null, failure_code: 'dispatch_outcome_unknown',
        reserved_until: null, state: 'uncertain'
      })] as Row[] };
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).reserve(reservation))
      .resolves.toMatchObject({
        kind: 'replayed',
        record: { failureCode: 'dispatch_outcome_unknown', state: 'uncertain' }
      });
  });

  test('records a replayed acceptance while uncertain so the terminal result can reconcile', async () => {
    const client = transactionalClient(async <Row>(sql: string) => {
      if (sql.includes('for update')) return { rows: [operationRow({
        command_id: 'command-one', command_sequence: '1', completed_at: reservation.reservedAt,
        dispatch_lease_until: null, failure_code: 'dispatch_outcome_unknown',
        reserved_until: null, state: 'uncertain'
      })] as Row[] };
      if (sql.includes('last_control_event_sequence = last_control_event_sequence + 1')) {
        return { rows: [{ last_control_event_sequence: 1 }] as Row[] };
      }
      if (sql.includes("state = 'uncertain'") && sql.includes('accepted_command_sequence = $3')) {
        return { rows: [operationRow({
          accepted_at: reservation.reservedAt, accepted_command_sequence: '1',
          accepted_event_sequence: '1', command_id: 'command-one', command_sequence: '1',
          completed_at: reservation.reservedAt, dispatch_lease_until: null,
          failure_code: 'dispatch_outcome_unknown', reserved_until: null, state: 'uncertain'
        })] as Row[] };
      }
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).accept({
      acceptedAt: reservation.reservedAt,
      acceptedCommandSequence: 1,
      command: { commandId: 'command-one', commandSequence: 1 },
      eventSequence: 1,
      fingerprint: reservation.fingerprint,
      identity
    })).resolves.toMatchObject({
      acceptedCommandSequence: 1, acceptedEventSequence: 1, state: 'uncertain'
    });
  });

  test('isolates replay identity by owner, actor, and exact Runtime session binding', async () => {
    const client = transactionalClient(async <Row>(sql: string) => ({
      rows: sql.includes('for update') ? [operationRow()] as Row[] : [] as Row[]
    }));
    const store = new PostgresCanonicalRuntimeControlOperationStore(client);
    await expect(store.reserve({
      ...reservation,
      identity: { ...identity, sessionId: '50000000-0000-4000-8000-000000000005' }
    })).resolves.toEqual({ kind: 'conflict' });
    await expect(store.reserve({
      ...reservation,
      identity: { ...identity, actorId: 'agent-other' }
    })).resolves.toEqual({ kind: 'conflict' });
  });

  test('rejects malformed persisted result evidence on read', async () => {
    const client = transactionalClient(async <Row>(sql: string) => ({
      rows: sql.includes('from canonical_runtime_control_operations') ? [operationRow({
        command_id: 'command-one', command_sequence: '1', completed_at: reservation.reservedAt,
        dispatch_lease_until: null, result_event_sequence: '2', reserved_until: null,
        safe_result: { operationId: identity.operationId, secret: 'must-not-survive' },
        state: 'completed'
      })] as Row[] : [] as Row[]
    }));
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).read(
      identity.ownerUserId, identity.operationId
    )).rejects.toThrow('Canonical Runtime control safe result is invalid.');
  });

  test('accepts only the exact bounded count summary for the reserved operation', () => {
    const result = {
      apiVersion: 1 as const,
      compatibilityAlias: false,
      environmentId,
      generation,
      operation: 'git.status' as const,
      operationId: identity.operationId,
      output: {
        clean: false,
        conflicted: 0,
        staged: 2,
        truncated: false,
        unstaged: 1,
        untracked: 0
      },
      replayed: false,
      state: 'completed' as const,
      targetIdentityRevision: identity.targetIdentityRevision,
      workspaceId
    };
    expect(() => validateSafeResult(result, identity)).not.toThrow();
    expect(() => validateSafeResult({
      ...result,
      output: { ...result.output, token: 'must-not-survive' }
    } as typeof result, identity)).toThrow('Canonical Runtime control safe result is invalid.');
    expect(() => validateSafeResult({
      ...result,
      output: { ...result.output, staged: Number.MAX_SAFE_INTEGER + 1 }
    }, identity)).toThrow('Canonical Runtime control safe result is invalid.');
  });

  test('keeps the same operation ID isolated between owners', async () => {
    const calls: readonly unknown[][] = [];
    const client = transactionalClient(async <Row>(sql: string, values: readonly unknown[] = []) => {
      (calls as unknown[][]).push([...values]);
      if (sql.includes('insert into canonical_runtime_control_operations')) {
        const ownerUserId = String(values[0]);
        return { rows: [operationRow({
          actor_user_id: ownerUserId,
          owner_user_id: ownerUserId
        })] as Row[] };
      }
      return { rows: [] as Row[] };
    });
    const otherOwner = { ...identity, actorUserId: 'owner-two', ownerUserId: 'owner-two' };
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).reserve({
      ...reservation, identity: otherOwner
    })).resolves.toMatchObject({ kind: 'new', record: { identity: otherOwner } });
    expect(calls.some((values) => values[0] ===
      'canonical-runtime-control-operation:owner-two:inspect-one')).toBe(true);
  });

  test('commits one exact terminal result after the matching command and event sequence', async () => {
    const result = {
      apiVersion: 1 as const,
      compatibilityAlias: false,
      environmentId,
      generation,
      operation: 'git.status' as const,
      operationId: identity.operationId,
      output: {
        clean: true, conflicted: 0, staged: 0, truncated: false, unstaged: 0, untracked: 0
      },
      replayed: false,
      state: 'completed' as const,
      targetIdentityRevision: identity.targetIdentityRevision,
      workspaceId
    };
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = transactionalClient(async <Row>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      const dispatching = operationRow({
        accepted_command_sequence: '7', accepted_event_sequence: '8',
        command_id: 'command-one', command_sequence: '7',
        dispatch_lease_until: '2026-08-12T10:00:31.000Z', reserved_until: null,
        state: 'dispatching'
      });
      if (sql.includes('for update')) return { rows: [dispatching] as Row[] };
      if (sql.includes('last_control_event_sequence = last_control_event_sequence + 1')) {
        return { rows: [{ last_control_event_sequence: '9' }] as Row[] };
      }
      if (sql.includes('safe_result = $5::jsonb')) return { rows: [{
        ...dispatching,
        completed_at: '2026-08-12T10:00:02.000Z',
        dispatch_lease_until: null,
        result_event_sequence: '9',
        safe_result: result,
        state: 'completed'
      }] as Row[] };
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).complete({
      command: { commandId: 'command-one', commandSequence: 7 },
      completedAt: '2026-08-12T10:00:02.000Z',
      fingerprint: reservation.fingerprint,
      identity,
      result,
      resultEventSequence: 9
    })).resolves.toMatchObject({
      acceptedEventSequence: 8,
      result,
      resultEventSequence: 9,
      state: 'completed'
    });
    const watermark = calls.find(({ sql }) =>
      sql.includes('last_control_event_sequence = last_control_event_sequence + 1'));
    expect(watermark?.sql).toContain('last_control_event_sequence + 1 = $6');
    expect(watermark?.values.slice(0, 6)).toEqual([
      'owner-one', workspaceId, environmentId, generation, sessionId, 9
    ]);
  });

  test('advances accepted events once and requires a contiguous generation watermark', async () => {
    const calls: string[] = [];
    const dispatching = operationRow({
      command_id: 'command-one', command_sequence: '7',
      dispatch_lease_until: '2026-08-12T10:00:31.000Z', reserved_until: null,
      state: 'dispatching'
    });
    const client = transactionalClient(async <Row>(sql: string) => {
      calls.push(sql);
      if (sql.includes('for update')) return { rows: [dispatching] as Row[] };
      if (sql.includes('last_control_event_sequence = last_control_event_sequence + 1')) {
        return { rows: [{ last_control_event_sequence: '8' }] as Row[] };
      }
      if (sql.includes('accepted_command_sequence = $3')) return { rows: [{
        ...dispatching,
        accepted_command_sequence: '7',
        accepted_event_sequence: '8'
      }] as Row[] };
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).accept({
      acceptedAt: '2026-08-12T10:00:01.000Z',
      acceptedCommandSequence: 7,
      command: { commandId: 'command-one', commandSequence: 7 },
      eventSequence: 8,
      fingerprint: reservation.fingerprint,
      identity
    })).resolves.toMatchObject({ acceptedCommandSequence: 7, acceptedEventSequence: 8 });
    expect(calls.some((sql) => sql.includes('last_control_event_sequence + 1 = $6'))).toBe(true);
  });

  test('reads restart-safe command and event watermarks for one owner generation', async () => {
    const client = transactionalClient(async <Row>(sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('select last_control_command_sequence')) {
        expect(values).toEqual(['owner-one', workspaceId, generation]);
        return { rows: [{
          last_control_command_sequence: '12',
          last_control_event_sequence: '19'
        }] as Row[] };
      }
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).watermarks(
      'owner-one', workspaceId, generation
    )).resolves.toEqual({ commandSequence: 12, eventSequence: 19 });
  });

  test('rejects an event gap without persisting acceptance', async () => {
    let acceptedWritten = false;
    const dispatching = operationRow({
      command_id: 'command-one', command_sequence: '7',
      dispatch_lease_until: '2026-08-12T10:00:31.000Z', reserved_until: null,
      state: 'dispatching'
    });
    const client = transactionalClient(async <Row>(sql: string) => {
      if (sql.includes('for update')) return { rows: [dispatching] as Row[] };
      if (sql.includes('accepted_command_sequence = $3')) acceptedWritten = true;
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).accept({
      acceptedAt: '2026-08-12T10:00:01.000Z',
      acceptedCommandSequence: 7,
      command: { commandId: 'command-one', commandSequence: 7 },
      eventSequence: 9,
      fingerprint: reservation.fingerprint,
      identity
    })).rejects.toThrow('Canonical Runtime control operation reservation changed.');
    expect(acceptedWritten).toBe(false);
  });
});

function operationRow(overrides: Partial<ReturnType<typeof baseOperationRow>> = {}) {
  return { ...baseOperationRow(), ...overrides };
}

function baseOperationRow() {
  return {
    accepted_command_sequence: null,
    accepted_event_sequence: null,
    actor_id: identity.actorId,
    actor_kind: identity.actorKind,
    actor_user_id: identity.actorUserId,
    command_id: null,
    command_sequence: null,
    compatibility_alias: identity.compatibilityAlias,
    completed_at: null,
    diff_staged: null,
    dispatch_lease_until: null,
    environment_id: identity.environmentId,
    failure_code: null,
    fingerprint_sha256: reservation.fingerprint,
    generation: identity.generation,
    operation: identity.operation,
    operation_id: identity.operationId,
    owner_user_id: identity.ownerUserId,
    reserved_until: reservation.reservedUntil,
    result_event_sequence: null,
    safe_result: null,
    session_id: identity.sessionId,
    state: 'reserved' as CanonicalRuntimeControlOperationState,
    target_identity_revision: identity.targetIdentityRevision,
    workspace_id: identity.workspaceId
  };
}

function transactionalClient(query: DatabaseQueryClient['query']): DatabaseQueryClient {
  const client: DatabaseQueryClient = {
    query,
    async transaction<Result>(operation: (transaction: DatabaseQueryClient) => Promise<Result>) {
      return operation(client);
    }
  };
  return client;
}
