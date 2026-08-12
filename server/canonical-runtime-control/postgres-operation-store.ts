import type { CanonicalRuntimeControlResult } from '../../src/shared/canonical-runtime-control-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  CanonicalRuntimeControlCommandCorrelation,
  CanonicalRuntimeControlFailureCode,
  CanonicalRuntimeControlOperationIdentity,
  CanonicalRuntimeControlOperationRecord,
  CanonicalRuntimeControlOperationState,
  CanonicalRuntimeControlOperationStore,
  CanonicalRuntimeControlPredispatchFailureInput,
  CanonicalRuntimeControlReservationInput,
  CanonicalRuntimeControlTerminalInput
} from './operation-store-contracts';
import {
  validateFailureCode,
  validateFingerprint,
  validateInstant,
  validateOperationIdentity,
  validatePositiveSequence,
  validateSafeResult
} from './operation-store-validation';

interface OperationRow {
  accepted_command_sequence: number | string | null;
  accepted_event_sequence: number | string | null;
  actor_id: string;
  actor_kind: CanonicalRuntimeControlOperationIdentity['actorKind'];
  actor_user_id: string;
  command_id: string | null;
  command_sequence: number | string | null;
  compatibility_alias: boolean;
  completed_at: Date | string | null;
  diff_staged: boolean | null;
  dispatch_lease_until: Date | string | null;
  environment_id: string;
  failure_code: CanonicalRuntimeControlFailureCode | null;
  fingerprint_sha256: string;
  generation: string;
  operation: CanonicalRuntimeControlOperationIdentity['operation'];
  operation_id: string;
  owner_user_id: string;
  reserved_until: Date | string | null;
  result_event_sequence: number | string | null;
  safe_result: unknown;
  session_id: string;
  state: CanonicalRuntimeControlOperationState;
  target_identity_revision: string;
  workspace_id: string;
}

const columns = `accepted_command_sequence, accepted_event_sequence, actor_id, actor_kind,
  actor_user_id, command_id, command_sequence, compatibility_alias, completed_at,
  diff_staged, dispatch_lease_until, environment_id::text, failure_code,
  fingerprint_sha256, generation::text, operation, operation_id, owner_user_id,
  reserved_until, result_event_sequence, safe_result, session_id::text, state,
  target_identity_revision, workspace_id::text`;

export class PostgresCanonicalRuntimeControlOperationStore
implements CanonicalRuntimeControlOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {
    if (!client.transaction) {
      throw new Error('Canonical Runtime control operations require database transactions.');
    }
  }

  reserve(input: CanonicalRuntimeControlReservationInput) {
    validateReservation(input);
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      const existing = await selectForUpdate(client, input.identity.ownerUserId, input.identity.operationId);
      if (existing) {
        if (existing.fingerprint_sha256 !== input.fingerprint ||
          !sameIdentityExceptSession(existing, input.identity)) return { kind: 'conflict' as const };
        if (existing.state === 'completed' || existing.state === 'failed') {
          return { kind: 'replayed' as const, record: rowToRecord(existing) };
        }
        if (!sameIdentity(existing, input.identity)) return { kind: 'conflict' as const };
        if (existing.state === 'reserved') {
          if (instant(existing.reserved_until) > Date.parse(input.reservedAt)) {
            return { kind: 'in_progress' as const };
          }
          const renewed = await client.query<OperationRow>(
            `update canonical_runtime_control_operations
                set reserved_until = $3::timestamptz, updated_at = $4::timestamptz
              where owner_user_id = $1 and operation_id = $2 and state = 'reserved'
                and reserved_until <= $4::timestamptz
              returning ${columns}`,
            [input.identity.ownerUserId, input.identity.operationId,
              input.reservedUntil, input.reservedAt]
          );
          if (!renewed.rows[0]) return { kind: 'in_progress' as const };
          return { kind: 'new' as const, record: rowToRecord(renewed.rows[0]) };
        }
        if (existing.state === 'dispatching' &&
          instant(existing.dispatch_lease_until) <= Date.parse(input.reservedAt)) {
          const uncertain = await client.query<OperationRow>(
            `update canonical_runtime_control_operations
                set state = 'uncertain', dispatch_lease_until = null,
                    failure_code = 'dispatch_outcome_unknown', completed_at = $3::timestamptz,
                    updated_at = $3::timestamptz
              where owner_user_id = $1 and operation_id = $2 and state = 'dispatching'
                and dispatch_lease_until <= $3::timestamptz
              returning ${columns}`,
            [input.identity.ownerUserId, input.identity.operationId, input.reservedAt]
          );
          if (uncertain.rows[0]) {
            return { kind: 'replayed' as const, record: rowToRecord(uncertain.rows[0]) };
          }
        }
        if (existing.state === 'dispatching') return { kind: 'in_progress' as const };
        return { kind: 'replayed' as const, record: rowToRecord(existing) };
      }

      const inserted = await client.query<OperationRow>(
        `insert into canonical_runtime_control_operations (
           owner_user_id, operation_id, fingerprint_sha256, actor_user_id, actor_id,
           actor_kind, compatibility_alias, operation, diff_staged, environment_id,
           target_identity_revision, workspace_id, generation, session_id, state,
           reserved_until, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11,
                   $12::uuid, $13::uuid, $14::uuid, 'reserved', $15::timestamptz,
                   $16::timestamptz, $16::timestamptz)
         returning ${columns}`,
        reservationValues(input)
      );
      const row = inserted.rows[0];
      if (!row) throw changed();
      return { kind: 'new' as const, record: rowToRecord(row) };
    });
  }

  markDispatchAttempted(input: Parameters<CanonicalRuntimeControlOperationStore['markDispatchAttempted']>[0]) {
    validateBoundInput(input);
    validateInstant(input.dispatchedAt, 'dispatch timestamp');
    validateInstant(input.dispatchedUntil, 'dispatch lease');
    if (Date.parse(input.dispatchedUntil) <= Date.parse(input.dispatchedAt) ||
      !/^[A-Za-z0-9:._-]{1,256}$/.test(input.commandId)) throw changed();
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      await lockGeneration(client, input.identity);
      const current = await selectForUpdate(client, input.identity.ownerUserId, input.identity.operationId);
      if (!current || current.state !== 'reserved' ||
        instant(current.reserved_until) <= Date.parse(input.dispatchedAt) ||
        current.fingerprint_sha256 !== input.fingerprint || !sameIdentity(current, input.identity)) {
        throw changed();
      }
      const sequence = await client.query<{ command_sequence: number | string }>(
        `update workspace_runtime_generations
            set last_control_command_sequence = last_control_command_sequence + 1,
                updated_at = $6::timestamptz
          where owner_user_id = $1 and workspace_id = $2::uuid and environment_id = $3::uuid
            and generation = $4::uuid and current_session_id = $5::uuid
          returning last_control_command_sequence as command_sequence`,
        [input.identity.ownerUserId, input.identity.workspaceId, input.identity.environmentId,
          input.identity.generation, input.identity.sessionId, input.dispatchedAt]
      );
      const commandSequence = sequenceNumber(sequence.rows[0]?.command_sequence);
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations
            set state = 'dispatching', dispatch_attempted = true, command_id = $3,
                command_sequence = $4, reserved_until = null,
                dispatch_lease_until = $5::timestamptz, updated_at = $6::timestamptz
          where owner_user_id = $1 and operation_id = $2 and state = 'reserved'
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId, input.commandId,
          commandSequence, input.dispatchedUntil, input.dispatchedAt]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }

  accept(input: Parameters<CanonicalRuntimeControlOperationStore['accept']>[0]) {
    validateBoundInput(input);
    validateCommand(input.command);
    validatePositiveSequence(input.acceptedCommandSequence, 'accepted command sequence');
    validatePositiveSequence(input.eventSequence, 'accepted event sequence');
    validateInstant(input.acceptedAt, 'accept timestamp');
    if (input.acceptedCommandSequence !== input.command.commandSequence) throw changed();
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      const current = await exactCurrent(client, input.identity, input.fingerprint, input.command);
      if (current.accepted_event_sequence !== null) {
        if (sequenceNumber(current.accepted_event_sequence) !== input.eventSequence ||
          optionalSequence(current.accepted_command_sequence) !== input.acceptedCommandSequence) {
          throw changed();
        }
        return rowToRecord(current);
      }
      if (current.state !== 'dispatching') throw changed();
      await advanceEventSequence(client, input.identity, input.eventSequence, input.acceptedAt);
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations
            set accepted_command_sequence = $3, accepted_event_sequence = $4,
                accepted_at = $5::timestamptz, updated_at = $5::timestamptz
          where owner_user_id = $1 and operation_id = $2 and state = 'dispatching'
            and accepted_event_sequence is null
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId,
          input.acceptedCommandSequence, input.eventSequence, input.acceptedAt]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }

  complete(input: CanonicalRuntimeControlTerminalInput) {
    validateTerminal(input);
    return this.finish(input, false);
  }

  failReserved(input: CanonicalRuntimeControlPredispatchFailureInput) {
    validateBoundInput(input);
    validateInstant(input.completedAt, 'completion timestamp');
    validateSafeResult(input.result, input.identity, input.failureCode);
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      const current = await selectForUpdate(
        client, input.identity.ownerUserId, input.identity.operationId
      );
      if (!current || current.fingerprint_sha256 !== input.fingerprint ||
        !sameIdentity(current, input.identity)) throw changed();
      if (current.state === 'failed') {
        const record = rowToRecord(current);
        if (record.command || record.failureCode !== input.failureCode ||
          stableJson(record.result) !== stableJson(input.result)) throw changed();
        return record;
      }
      if (current.state !== 'reserved') throw changed();
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations
            set state = 'failed', failure_code = $3, safe_result = $4::jsonb,
                reserved_until = null, completed_at = $5::timestamptz,
                updated_at = $5::timestamptz
          where owner_user_id = $1 and operation_id = $2 and state = 'reserved'
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId, input.failureCode,
          JSON.stringify(input.result), input.completedAt]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }

  reconcile(input: CanonicalRuntimeControlTerminalInput) {
    validateTerminal(input);
    return this.finish(input, true);
  }

  markUncertain(input: Parameters<CanonicalRuntimeControlOperationStore['markUncertain']>[0]) {
    validateBoundInput(input);
    validateCommand(input.command);
    validateInstant(input.completedAt, 'completion timestamp');
    if (input.resultEventSequence !== undefined) {
      validatePositiveSequence(input.resultEventSequence, 'uncertain result event sequence');
    }
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      const current = await exactCurrent(client, input.identity, input.fingerprint, input.command);
      if (current.state === 'uncertain') return rowToRecord(current);
      if (current.state !== 'dispatching') throw changed();
      if (input.resultEventSequence !== undefined) {
        await advanceEventSequence(
          client, input.identity, input.resultEventSequence, input.completedAt
        );
      }
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations
            set state = 'uncertain', dispatch_lease_until = null,
                failure_code = 'dispatch_outcome_unknown', completed_at = $3::timestamptz,
                result_event_sequence = $4,
                updated_at = $3::timestamptz
          where owner_user_id = $1 and operation_id = $2 and state = 'dispatching'
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId, input.completedAt,
          input.resultEventSequence ?? null]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }

  async read(ownerUserId: string, operationId: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns} from canonical_runtime_control_operations
        where owner_user_id = $1 and operation_id = $2`,
      [ownerUserId, operationId]
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  rebindSession(input: Parameters<CanonicalRuntimeControlOperationStore['rebindSession']>[0]) {
    validateBoundInput(input);
    validateCommand(input.command);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.sessionId)) throw changed();
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      await lockGeneration(client, input.identity);
      const current = await exactCurrent(client, input.identity, input.fingerprint, input.command);
      if (current.state !== 'dispatching' && current.state !== 'uncertain') throw changed();
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations operation
            set session_id = $3::uuid, updated_at = now()
          where owner_user_id = $1 and operation_id = $2
            and exists (
              select 1 from workspace_runtime_generations generation
               where generation.owner_user_id = operation.owner_user_id
                 and generation.workspace_id = operation.workspace_id
                 and generation.environment_id = operation.environment_id
                 and generation.generation = operation.generation
                 and generation.current_session_id = $3::uuid
            )
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId, input.sessionId]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }

  async unresolved(ownerUserId: string, workspaceId: string, generation: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns} from canonical_runtime_control_operations
        where owner_user_id = $1 and workspace_id = $2::uuid and generation = $3::uuid
          and state in ('dispatching', 'uncertain')
        order by command_sequence asc`,
      [ownerUserId, workspaceId, generation]
    );
    return result.rows.map(rowToRecord);
  }

  async watermarks(ownerUserId: string, workspaceId: string, generation: string) {
    const result = await this.client.query<{
      last_control_command_sequence: number | string;
      last_control_event_sequence: number | string;
    }>(
      `select last_control_command_sequence, last_control_event_sequence
         from workspace_runtime_generations
        where owner_user_id = $1 and workspace_id = $2::uuid and generation = $3::uuid`,
      [ownerUserId, workspaceId, generation]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      commandSequence: watermarkNumber(row.last_control_command_sequence),
      eventSequence: watermarkNumber(row.last_control_event_sequence)
    };
  }

  private finish(input: CanonicalRuntimeControlTerminalInput, reconcile: boolean) {
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.identity.ownerUserId, input.identity.operationId);
      const current = await exactCurrent(client, input.identity, input.fingerprint, input.command);
      if (current.state === 'completed' || current.state === 'failed') {
        const record = rowToRecord(current);
        if (record.resultEventSequence !== input.resultEventSequence ||
          record.failureCode !== input.failureCode || stableJson(record.result) !== stableJson(input.result)) {
          throw changed();
        }
        return record;
      }
      const leaseExpired = current.state === 'dispatching' &&
        instant(current.dispatch_lease_until) <= Date.parse(input.completedAt);
      if (reconcile ? current.state !== 'uncertain' && !leaseExpired : current.state !== 'dispatching') {
        throw changed();
      }
      const acceptedEvent = optionalSequence(current.accepted_event_sequence);
      if (acceptedEvent !== undefined && input.resultEventSequence <= acceptedEvent) throw changed();
      await advanceEventSequence(
        client, input.identity, input.resultEventSequence, input.completedAt
      );
      const updated = await client.query<OperationRow>(
        `update canonical_runtime_control_operations
            set state = $3, failure_code = $4, safe_result = $5::jsonb,
                result_event_sequence = $6, reserved_until = null, dispatch_lease_until = null,
                completed_at = $7::timestamptz, updated_at = $7::timestamptz
          where owner_user_id = $1 and operation_id = $2 and
                ${reconcile
                  ? "(state = 'uncertain' or (state = 'dispatching' and dispatch_lease_until <= $7::timestamptz))"
                  : "state = 'dispatching'"}
          returning ${columns}`,
        [input.identity.ownerUserId, input.identity.operationId, input.result.state,
          input.failureCode ?? null, JSON.stringify(input.result), input.resultEventSequence,
          input.completedAt]
      );
      if (!updated.rows[0]) throw changed();
      return rowToRecord(updated.rows[0]);
    });
  }
}

function validateReservation(input: CanonicalRuntimeControlReservationInput) {
  validateBoundInput(input);
  validateInstant(input.reservedAt, 'reservation timestamp');
  validateInstant(input.reservedUntil, 'reservation lease');
  if (Date.parse(input.reservedUntil) <= Date.parse(input.reservedAt)) throw changed();
}

function validateBoundInput(input: {
  fingerprint: string;
  identity: CanonicalRuntimeControlOperationIdentity;
}) {
  validateOperationIdentity(input.identity);
  validateFingerprint(input.fingerprint);
}

function validateTerminal(input: CanonicalRuntimeControlTerminalInput) {
  validateBoundInput(input);
  validateCommand(input.command);
  validatePositiveSequence(input.resultEventSequence, 'result event sequence');
  validateInstant(input.completedAt, 'completion timestamp');
  validateFailureCode(input.result.state, input.failureCode);
  validateSafeResult(input.result, input.identity, input.failureCode);
}

function validateCommand(command: CanonicalRuntimeControlCommandCorrelation) {
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(command.commandId)) throw changed();
  validatePositiveSequence(command.commandSequence, 'command sequence');
}

async function exactCurrent(
  client: DatabaseQueryClient,
  identity: CanonicalRuntimeControlOperationIdentity,
  fingerprint: string,
  command: CanonicalRuntimeControlCommandCorrelation
) {
  const current = await selectForUpdate(client, identity.ownerUserId, identity.operationId);
  if (!current || current.fingerprint_sha256 !== fingerprint || !sameIdentity(current, identity) ||
    current.command_id !== command.commandId ||
    optionalSequence(current.command_sequence) !== command.commandSequence) throw changed();
  return current;
}

async function selectForUpdate(client: DatabaseQueryClient, ownerUserId: string, operationId: string) {
  const result = await client.query<OperationRow>(
    `select ${columns} from canonical_runtime_control_operations
      where owner_user_id = $1 and operation_id = $2 for update`,
    [ownerUserId, operationId]
  );
  return result.rows[0];
}

function reservationValues(input: CanonicalRuntimeControlReservationInput) {
  const identity = input.identity;
  return [identity.ownerUserId, identity.operationId, input.fingerprint, identity.actorUserId,
    identity.actorId, identity.actorKind, identity.compatibilityAlias, identity.operation,
    identity.diffStaged ?? null, identity.environmentId, identity.targetIdentityRevision,
    identity.workspaceId, identity.generation, identity.sessionId, input.reservedUntil,
    input.reservedAt];
}

function sameIdentity(row: OperationRow, identity: CanonicalRuntimeControlOperationIdentity) {
  return sameIdentityExceptSession(row, identity) && row.session_id === identity.sessionId;
}

function sameIdentityExceptSession(
  row: OperationRow,
  identity: CanonicalRuntimeControlOperationIdentity
) {
  return row.owner_user_id === identity.ownerUserId && row.operation_id === identity.operationId &&
    row.actor_user_id === identity.actorUserId && row.actor_id === identity.actorId &&
    row.actor_kind === identity.actorKind && row.compatibility_alias === identity.compatibilityAlias &&
    row.operation === identity.operation && row.diff_staged === (identity.diffStaged ?? null) &&
    row.environment_id === identity.environmentId &&
    row.target_identity_revision === identity.targetIdentityRevision &&
    row.workspace_id === identity.workspaceId && row.generation === identity.generation;
}

function rowToRecord(row: OperationRow): CanonicalRuntimeControlOperationRecord {
  const identity: CanonicalRuntimeControlOperationIdentity = {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    compatibilityAlias: row.compatibility_alias,
    ...(row.diff_staged === null ? {} : { diffStaged: row.diff_staged }),
    environmentId: row.environment_id,
    generation: row.generation,
    operation: row.operation,
    operationId: row.operation_id,
    ownerUserId: row.owner_user_id,
    sessionId: row.session_id,
    targetIdentityRevision: row.target_identity_revision,
    workspaceId: row.workspace_id
  };
  validateOperationIdentity(identity);
  validateFingerprint(row.fingerprint_sha256);
  const command = row.command_id === null || row.command_sequence === null ? undefined : {
    commandId: row.command_id,
    commandSequence: sequenceNumber(row.command_sequence)
  };
  if ((row.state === 'reserved' && command !== undefined) ||
    (['dispatching', 'completed', 'uncertain'].includes(row.state) && command === undefined) ||
    (row.state === 'uncertain' && row.failure_code !== 'dispatch_outcome_unknown')) throw invalidRow();
  const result = row.safe_result === null ? undefined : row.safe_result as CanonicalRuntimeControlResult;
  if (result) validateSafeResult(result, identity, row.failure_code ?? undefined);
  if ((row.state === 'completed' || row.state === 'failed') !== Boolean(result)) throw invalidRow();
  const acceptedCommandSequence = optionalSequence(row.accepted_command_sequence);
  const acceptedEventSequence = optionalSequence(row.accepted_event_sequence);
  if ((acceptedCommandSequence === undefined) !== (acceptedEventSequence === undefined) ||
    acceptedCommandSequence !== undefined && acceptedCommandSequence !== command?.commandSequence) {
    throw invalidRow();
  }
  return {
    ...(acceptedCommandSequence === undefined ? {} : { acceptedCommandSequence }),
    ...(acceptedEventSequence === undefined ? {} : { acceptedEventSequence }),
    ...(command ? { command } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    fingerprint: row.fingerprint_sha256,
    identity,
    ...(result ? { result } : {}),
    ...(row.result_event_sequence === null ? {} : {
      resultEventSequence: sequenceNumber(row.result_event_sequence)
    }),
    state: row.state
  };
}

function lockOperation(client: DatabaseQueryClient, ownerUserId: string, operationId: string) {
  return client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `canonical-runtime-control-operation:${ownerUserId}:${operationId}`
  ]);
}

function lockGeneration(client: DatabaseQueryClient, identity: CanonicalRuntimeControlOperationIdentity) {
  return client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `canonical-runtime-control-generation:${identity.ownerUserId}:${identity.workspaceId}:${identity.generation}`
  ]);
}

async function advanceEventSequence(
  client: DatabaseQueryClient,
  identity: CanonicalRuntimeControlOperationIdentity,
  eventSequence: number,
  observedAt: string
) {
  await lockGeneration(client, identity);
  const updated = await client.query(
    `update workspace_runtime_generations
        set last_control_event_sequence = last_control_event_sequence + 1,
            updated_at = $7::timestamptz
      where owner_user_id = $1 and workspace_id = $2::uuid and environment_id = $3::uuid
        and generation = $4::uuid and current_session_id = $5::uuid
        and last_control_event_sequence + 1 = $6
        and last_control_event_sequence < $6
      returning last_control_event_sequence`,
    [identity.ownerUserId, identity.workspaceId, identity.environmentId, identity.generation,
      identity.sessionId, eventSequence, observedAt]
  );
  if (updated.rows.length !== 1) throw changed();
}

function optionalSequence(value: number | string | null) {
  return value === null ? undefined : sequenceNumber(value);
}

function sequenceNumber(value: number | string | undefined) {
  const result = Number(value);
  validatePositiveSequence(result);
  return result;
}

function watermarkNumber(value: number | string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw invalidRow();
  return result;
}

function instant(value: Date | string | null) {
  if (value === null) throw invalidRow();
  const parsed = Date.parse(iso(value));
  if (!Number.isFinite(parsed)) throw invalidRow();
  return parsed;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function changed() {
  return new Error('Canonical Runtime control operation reservation changed.');
}

function invalidRow() {
  return new Error('Canonical Runtime control persisted evidence is invalid.');
}
