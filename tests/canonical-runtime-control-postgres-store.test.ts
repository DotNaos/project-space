import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import type { CanonicalRuntimeControlResult } from '../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlOperationIdentity,
  CanonicalRuntimeControlOperationState
} from '../server/canonical-runtime-control/operation-store-contracts';
import { PostgresCanonicalRuntimeControlOperationStore } from
  '../server/canonical-runtime-control/postgres-operation-store';
import { MemoryCanonicalRuntimeControlOperationStore } from
  '../server/canonical-runtime-control/memory-operation-store';
import { validateSafeInput, validateSafeResult } from
  '../server/canonical-runtime-control/operation-store-validation';

const environmentId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const generation = '30000000-0000-4000-8000-000000000003';
const sessionId = '40000000-0000-4000-8000-000000000004';
const identity: CanonicalRuntimeControlOperationIdentity = {
  accessMode: 'read',
  actorId: 'agent-nora',
  actorKind: 'agent',
  actorUserId: 'owner-one',
  compatibilityAlias: false,
  environmentId,
  generation,
  operation: 'git.status',
  operationId: 'inspect-one',
  ownerUserId: 'owner-one',
  safeInput: { operation: 'git.status' },
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
      'git.status', null, '{"operation":"git.status"}', 'read', environmentId,
      '1:revision_one', workspaceId, generation, sessionId,
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

  test('advances the event watermark for the first terminal uncertain replay', async () => {
    const client = transactionalClient(async <Row>(sql: string) => {
      if (sql.includes('for update')) return { rows: [operationRow({
        accepted_command_sequence: '1', accepted_event_sequence: '1',
        command_id: 'command-one', command_sequence: '1', completed_at: reservation.reservedAt,
        dispatch_lease_until: null, failure_code: 'dispatch_outcome_unknown',
        reserved_until: null, state: 'uncertain'
      })] as Row[] };
      if (sql.includes('last_control_event_sequence = last_control_event_sequence + 1')) {
        return { rows: [{ last_control_event_sequence: 2 }] as Row[] };
      }
      if (sql.includes('set result_event_sequence = $3')) return { rows: [operationRow({
        accepted_command_sequence: '1', accepted_event_sequence: '1',
        command_id: 'command-one', command_sequence: '1', completed_at: reservation.reservedAt,
        dispatch_lease_until: null, failure_code: 'dispatch_outcome_unknown',
        reserved_until: null, result_event_sequence: '2', state: 'uncertain'
      })] as Row[] };
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).markUncertain({
      command: { commandId: 'command-one', commandSequence: 1 },
      completedAt: reservation.reservedAt, fingerprint: reservation.fingerprint,
      identity, resultEventSequence: 2
    })).resolves.toMatchObject({ resultEventSequence: 2, state: 'uncertain' });
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

  test('accepts only closed bounded mutation inputs', () => {
    expect(validateSafeInput({
      expectedHead: 'b'.repeat(40), operation: 'git.stage', scope: 'all'
    })).toEqual({ expectedHead: 'b'.repeat(40), operation: 'git.stage', scope: 'all' });
    expect(() => validateSafeInput({
      expectedHead: 'b'.repeat(40), operation: 'git.stage', scope: 'all', path: '/private'
    } as never)).toThrow('Canonical Runtime control safe input is invalid.');
    expect(() => validateSafeInput({
      expectedHead: 'b'.repeat(40), message: 'line one\nline two', operation: 'git.commit'
    })).toThrow('Canonical Runtime control safe input is invalid.');
    expect(() => validateSafeInput({
      expectedServerGeneration: '', operation: 'dev-server.stop', serverId: 'docs'
    })).toThrow('Canonical Runtime control safe input is invalid.');
    expect(validateSafeInput({
      expectedServerGeneration: 'generation:docs_2', operation: 'dev-server.stop',
      serverId: 'docs'
    })).toEqual({
      expectedServerGeneration: 'generation:docs_2', operation: 'dev-server.stop',
      serverId: 'docs'
    });
    expect(() => validateSafeInput({
      expectedServerGeneration: 'generation docs', operation: 'dev-server.stop', serverId: 'docs'
    })).toThrow('Canonical Runtime control safe input is invalid.');
  });

  test('keeps one unresolved mutation fence per owner Workspace generation', async () => {
    const store = new MemoryCanonicalRuntimeControlOperationStore();
    const first = mutationReservation('mutation-one');
    const second = mutationReservation('mutation-two');
    await expect(store.reserve(first)).resolves.toMatchObject({ kind: 'new' });
    await expect(store.reserve(second)).resolves.toEqual({ kind: 'in_progress' });
    await expect(store.reserve({
      ...first,
      identity: {
        ...first.identity,
        safeInput: { expectedHead: 'c'.repeat(40), operation: 'git.stage', scope: 'all' }
      }
    })).resolves.toEqual({ kind: 'conflict' });
    await store.failReserved({
      completedAt: '2026-08-12T10:00:01.000Z', failureCode: 'authorization_denied',
      fingerprint: first.fingerprint, identity: first.identity,
      result: failedResult(first.identity)
    });
    await expect(store.reserve(second)).resolves.toMatchObject({ kind: 'new' });
    await expect(store.reserve(mutationReservation('mutation-three', {
      ownerUserId: 'owner-two', actorUserId: 'owner-two'
    }))).resolves.toMatchObject({ kind: 'new' });
  });

  test('does not release a mutation fence while its outcome is uncertain', async () => {
    const store = new MemoryCanonicalRuntimeControlOperationStore();
    const first = mutationReservation('mutation-uncertain');
    await store.reserve(first);
    const dispatched = await store.markDispatchAttempted({
      commandId: first.identity.operationId, dispatchedAt: '2026-08-12T10:00:01.000Z',
      dispatchedUntil: '2026-08-12T10:00:31.000Z', fingerprint: first.fingerprint,
      identity: first.identity
    });
    await store.markUncertain({
      command: dispatched.command!, completedAt: '2026-08-12T10:00:32.000Z',
      fingerprint: first.fingerprint, identity: first.identity
    });
    await expect(store.unresolved(
      first.identity.ownerUserId, first.identity.workspaceId, first.identity.generation
    )).resolves.toMatchObject([{
      identity: { accessMode: 'mutation', safeInput: first.identity.safeInput },
      state: 'uncertain'
    }]);
    await expect(store.reserve(mutationReservation('mutation-after-uncertain')))
      .resolves.toEqual({ kind: 'in_progress' });
  });

  test('checks the durable mutation fence before inserting a different operation ID', async () => {
    let inserted = false;
    const client = transactionalClient(async <Row>(sql: string) => {
      if (sql.includes("access_mode = 'mutation'")) return { rows: [{ exists: 1 }] as Row[] };
      if (sql.includes('insert into canonical_runtime_control_operations')) inserted = true;
      return { rows: [] as Row[] };
    });
    await expect(new PostgresCanonicalRuntimeControlOperationStore(client).reserve(
      mutationReservation('mutation-fenced')
    )).resolves.toEqual({ kind: 'in_progress' });
    expect(inserted).toBe(false);
  });

  test('allows blocked_dependency evidence only for task start', () => {
    const taskIdentity: CanonicalRuntimeControlOperationIdentity = {
      ...identity,
      accessMode: 'mutation',
      operation: 'task.start',
      operationId: 'task-start-one',
      safeInput: {
        operation: 'task.start', taskExecutionId: environmentId, workspaceLeaseId: workspaceId
      }
    };
    const blocked = {
      apiVersion: 1 as const, compatibilityAlias: false, environmentId,
      generation, operation: 'task.start' as const, operationId: taskIdentity.operationId,
      replayed: false, state: 'blocked_dependency' as const,
      targetIdentityRevision: identity.targetIdentityRevision, workspaceId
    };
    expect(() => validateSafeResult(blocked, taskIdentity, 'blocked_dependency')).not.toThrow();
    expect(() => validateSafeResult({
      ...blocked, operation: 'git.stage' as const
    }, mutationReservation('blocked-git').identity, 'blocked_dependency'))
      .toThrow('Canonical Runtime control safe result is invalid.');
    expect(() => validateSafeResult({
      ...blocked, state: 'failed' as const
    }, taskIdentity, 'blocked_dependency'))
      .toThrow('Canonical Runtime control safe result is invalid.');
  });

  test('binds mutation outputs to their reserved compare-and-swap input', () => {
    const stage = mutationReservation('stage-bound');
    const stageResult = completedResult(stage.identity, {
      changed: true, clean: false, conflicted: 0, head: 'b'.repeat(40), staged: 1,
      truncated: false, unstaged: 0, untracked: 0
    });
    expect(() => validateSafeResult(stageResult, stage.identity)).not.toThrow();
    expect(() => validateSafeResult({
      ...stageResult, output: { ...stageResult.output, head: 'c'.repeat(40) }
    }, stage.identity)).toThrow('Canonical Runtime control safe result is invalid.');

    const publishIdentity: CanonicalRuntimeControlOperationIdentity = {
      ...identity, accessMode: 'mutation', operation: 'dev-server.publish',
      operationId: 'publish-bound', safeInput: {
        expectedServerGeneration: 'generation:docs_2', operation: 'dev-server.publish',
        serverId: 'docs'
      }
    };
    const publishResult = completedResult(publishIdentity, {
      serverGeneration: 'generation:docs_3', serverId: 'docs', state: 'published'
    });
    expect(() => validateSafeResult(publishResult, publishIdentity)).not.toThrow();
    expect(() => validateSafeResult({
      ...publishResult,
      output: { ...publishResult.output, serverGeneration: 'generation:docs_2' }
    }, publishIdentity)).toThrow('Canonical Runtime control safe result is invalid.');
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
    access_mode: identity.accessMode,
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
    safe_input: identity.safeInput,
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

function mutationReservation(
  operationId: string,
  overrides: Partial<CanonicalRuntimeControlOperationIdentity> = {}
) {
  const mutationIdentity: CanonicalRuntimeControlOperationIdentity = {
    ...identity,
    accessMode: 'mutation',
    operation: 'git.stage',
    operationId,
    safeInput: { expectedHead: 'b'.repeat(40), operation: 'git.stage', scope: 'all' },
    ...overrides
  };
  return { ...reservation, fingerprint: 'b'.repeat(64), identity: mutationIdentity };
}

function failedResult(bound: CanonicalRuntimeControlOperationIdentity) {
  return {
    apiVersion: 1 as const,
    compatibilityAlias: bound.compatibilityAlias,
    environmentId: bound.environmentId,
    generation: bound.generation,
    operation: bound.operation,
    operationId: bound.operationId,
    replayed: false,
    state: 'failed' as const,
    targetIdentityRevision: bound.targetIdentityRevision,
    workspaceId: bound.workspaceId
  };
}

function completedResult(
  bound: CanonicalRuntimeControlOperationIdentity,
  output: Record<string, unknown>
) {
  return {
    apiVersion: 1 as const,
    compatibilityAlias: bound.compatibilityAlias,
    environmentId: bound.environmentId,
    generation: bound.generation,
    operation: bound.operation,
    operationId: bound.operationId,
    output,
    replayed: false,
    state: 'completed' as const,
    targetIdentityRevision: bound.targetIdentityRevision,
    workspaceId: bound.workspaceId
  } as CanonicalRuntimeControlResult;
}
