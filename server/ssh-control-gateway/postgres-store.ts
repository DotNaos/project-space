import type { DatabaseQueryClient } from '../database/client';
import type {
  SshGatewayOperationRecord,
  SshGatewayOperationState,
  SshGatewayOperationStore,
  SshGatewayStatusResult
} from './contracts';
import { SshGatewayError } from './contracts';
import { validateReservation } from './store-validation';

interface OperationRow {
  actor_id: string;
  actor_kind: 'human' | 'machine';
  capability: 'project_cli';
  completed_at: Date | string | null;
  dispatch_lease_until: Date | string | null;
  fingerprint_sha256: string;
  gateway_id: string;
  operation: 'status.v1';
  operation_id: string;
  reserved_until: Date | string | null;
  route_id: string;
  safe_result: unknown;
  state: SshGatewayOperationState;
  target_identity_revision: string;
  environment_id: string;
}

export class PostgresSshGatewayOperationStore implements SshGatewayOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {
    if (!client.transaction) throw new Error('SSH gateway store requires database transactions.');
  }

  async reserve(input: Parameters<SshGatewayOperationStore['reserve']>[0]) {
    validateReservation(input);
    const run = async (client: DatabaseQueryClient) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `ssh-gateway-operation:${input.ownerUserId}:${input.operationId}`
      ]);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `ssh-gateway-target:${input.ownerUserId}:${input.targetEnvironmentId}`
      ]);
      const existing = await client.query<OperationRow>(
        `${selectColumns}
           from ssh_gateway_operations
          where owner_user_id = $1 and operation_id = $2
          for update`,
        [input.ownerUserId, input.operationId]
      );
      const current = existing.rows[0];
      if (current) {
        if (current.fingerprint_sha256 !== input.fingerprint) {
          throw new SshGatewayError('operation_conflict', 'Operation identity was reused.');
        }
        if (['reserved', 'dispatching', 'uncertain'].includes(current.state) && (
          current.route_id !== input.audit.routeId ||
          current.environment_id !== input.audit.targetEnvironmentId ||
          current.target_identity_revision !== input.audit.targetIdentityRevision ||
          current.gateway_id !== input.audit.gatewayId ||
          current.actor_id !== input.audit.actorId || current.actor_kind !== input.audit.actorKind)) {
          throw new SshGatewayError('operation_conflict', 'Operation reservation binding changed.');
        }
        if (current.state === 'reserved') {
          const renewed = await client.query<OperationRow>(
            `update ssh_gateway_operations
                set reserved_until = now() + interval '1 minute', updated_at = now()
              where owner_user_id = $1 and operation_id = $2
                and fingerprint_sha256 = $3 and state = 'reserved'
                and reserved_until <= now()
              returning actor_id, actor_kind, capability, completed_at, dispatch_lease_until,
                        fingerprint_sha256, gateway_id, operation, operation_id,
                        reserved_until, route_id::text, safe_result, state,
                        target_identity_revision, environment_id::text`,
            [input.ownerUserId, input.operationId, input.fingerprint]
          );
          if (renewed.rows[0]) {
            await insertEvent(client, input.ownerUserId, input.operationId, 'reservation_expired');
            await insertEvent(client, input.ownerUserId, input.operationId, 'reserved');
            return { record: rowToRecord(renewed.rows[0]), replayed: false };
          }
        }
        return { record: rowToRecord(current), replayed: true };
      }
      const expired = await client.query<{ operation_id: string }>(
        `update ssh_gateway_operations
            set state = 'failed', reserved_until = null, dispatch_lease_until = null,
                completed_at = now(), updated_at = now()
          where owner_user_id = $1 and environment_id = $2::uuid
            and state = 'reserved' and reserved_until <= now()
          returning operation_id`,
        [input.ownerUserId, input.targetEnvironmentId]
      );
      for (const row of expired.rows) {
        await insertEvent(client, input.ownerUserId, row.operation_id, 'reservation_expired');
      }
      const active = await client.query(
        `select 1 from ssh_gateway_operations
          where owner_user_id = $1 and environment_id = $2::uuid
            and state in ('reserved', 'dispatching', 'uncertain') limit 1`,
        [input.ownerUserId, input.targetEnvironmentId]
      );
      if (active.rows.length > 0) {
        throw new SshGatewayError('operation_in_progress', 'Another operation fences this target.');
      }
      await client.query(
        `insert into ssh_gateway_operations (
           owner_user_id, operation_id, fingerprint_sha256, actor_kind, actor_id,
           environment_id, target_identity_revision, route_id, gateway_id,
           capability, operation, state, reserved_until
         ) values ($1, $2, $3, $4, $5, $6::uuid, $7, $8::uuid, $9,
                   'project_cli', $10, 'reserved', now() + interval '1 minute')`,
        [
          input.ownerUserId, input.operationId, input.fingerprint,
          input.audit.actorKind, input.audit.actorId, input.audit.targetEnvironmentId,
          input.audit.targetIdentityRevision, input.audit.routeId, input.audit.gatewayId,
          input.audit.operation
        ]
      );
      await insertEvent(client, input.ownerUserId, input.operationId, 'reserved');
      return {
        record: {
          audit: input.audit,
          fingerprint: input.fingerprint,
          state: 'reserved' as const
        },
        replayed: false
      };
    };
    return this.client.transaction!(run);
  }

  async markDispatchAttempted(
    input: Parameters<SshGatewayOperationStore['markDispatchAttempted']>[0]
  ) {
    const run = async (client: DatabaseQueryClient) => {
      const updated = await client.query(
        `update ssh_gateway_operations
            set state = 'dispatching', dispatch_attempted = true,
                reserved_until = null, dispatch_lease_until = now() + interval '1 minute',
                updated_at = now()
          where owner_user_id = $1 and operation_id = $2
            and fingerprint_sha256 = $3 and state = 'reserved' and reserved_until > now()
          returning operation_id`,
        [input.ownerUserId, input.operationId, input.fingerprint]
      );
      if (updated.rows.length !== 1) {
        throw new SshGatewayError('operation_conflict', 'Operation cannot be dispatched.');
      }
      await insertEvent(client, input.ownerUserId, input.operationId, 'dispatch_attempted');
    };
    await this.client.transaction!(run);
  }

  async complete(input: Parameters<SshGatewayOperationStore['complete']>[0]) {
    const run = async (client: DatabaseQueryClient) => {
      const existing = await client.query<OperationRow>(
        `${selectColumns} from ssh_gateway_operations
          where owner_user_id = $1 and operation_id = $2 for update`,
        [input.ownerUserId, input.operationId]
      );
      const current = existing.rows[0];
      if (!current || current.fingerprint_sha256 !== input.fingerprint ||
        !['reserved', 'dispatching'].includes(current.state) ||
        (['succeeded', 'incompatible', 'uncertain'].includes(input.state) &&
          current.state !== 'dispatching')) {
        throw new SshGatewayError('operation_conflict', 'Operation cannot be completed.');
      }
      validateSafeResult(input.state, input.result, {
        operationId: current.operation_id,
        targetIdentityRevision: current.target_identity_revision
      });
      const updated = await client.query<OperationRow>(
        `update ssh_gateway_operations
            set state = $3,
                safe_result = $4::jsonb,
                reserved_until = null,
                dispatch_lease_until = null,
                completed_at = now(),
                updated_at = now()
          where owner_user_id = $1 and operation_id = $2
            and fingerprint_sha256 = $5
            and state in ('reserved', 'dispatching')
            and ($3 not in ('succeeded', 'incompatible', 'uncertain') or state = 'dispatching')
          returning actor_id, actor_kind, capability, completed_at, dispatch_lease_until,
                    fingerprint_sha256, gateway_id, operation, operation_id, reserved_until,
                    route_id::text, safe_result, state, target_identity_revision,
                    environment_id::text`,
        [
          input.ownerUserId, input.operationId, input.state,
          input.result ? JSON.stringify(input.result) : null, input.fingerprint
        ]
      );
      const row = updated.rows[0];
      if (!row) throw new SshGatewayError('operation_conflict', 'Operation cannot be completed.');
      await insertEvent(client, input.ownerUserId, input.operationId, input.state);
      return rowToRecord(row);
    };
    return this.client.transaction!(run);
  }

  async reconcile(input: Parameters<SshGatewayOperationStore['reconcile']>[0]) {
    const run = async (client: DatabaseQueryClient) => {
      const existing = await client.query<OperationRow>(
        `${selectColumns} from ssh_gateway_operations
          where owner_user_id = $1 and operation_id = $2 for update`,
        [input.ownerUserId, input.operationId]
      );
      const current = existing.rows[0];
      if (!current || current.fingerprint_sha256 !== input.fingerprint ||
        !['dispatching', 'uncertain'].includes(current.state)) {
        throw new SshGatewayError('operation_conflict', 'Operation cannot be reconciled.');
      }
      validateSafeResult(input.state, input.result, {
        operationId: current.operation_id,
        targetIdentityRevision: current.target_identity_revision
      });
      const updated = await client.query<OperationRow>(
        `update ssh_gateway_operations
            set state = $3, safe_result = $4::jsonb, reserved_until = null,
                dispatch_lease_until = null,
                completed_at = now(), updated_at = now()
          where owner_user_id = $1 and operation_id = $2
            and fingerprint_sha256 = $5 and (
              state = 'uncertain' or
              (state = 'dispatching' and dispatch_lease_until <= now())
            )
          returning actor_id, actor_kind, capability, completed_at, dispatch_lease_until,
                    fingerprint_sha256, gateway_id, operation, operation_id, reserved_until,
                    route_id::text, safe_result, state, target_identity_revision,
                    environment_id::text`,
        [
          input.ownerUserId, input.operationId, input.state,
          input.result ? JSON.stringify(input.result) : null, input.fingerprint
        ]
      );
      const row = updated.rows[0];
      if (!row) throw new SshGatewayError('operation_conflict', 'Operation cannot be reconciled.');
      await insertEvent(client, input.ownerUserId, input.operationId, `reconciled_${input.state}`);
      return rowToRecord(row);
    };
    return this.client.transaction!(run);
  }
}

const selectColumns = `select actor_id, actor_kind, capability, completed_at, dispatch_lease_until,
  fingerprint_sha256, gateway_id, operation, operation_id, reserved_until, route_id::text,
  safe_result, state, target_identity_revision, environment_id::text`;

async function insertEvent(
  client: DatabaseQueryClient,
  ownerUserId: string,
  operationId: string,
  event: SshGatewayOperationState | 'dispatch_attempted' | 'reservation_expired' |
    'reconciled_succeeded' | 'reconciled_failed'
) {
  await client.query(
    `insert into ssh_gateway_operation_events (owner_user_id, operation_id, event_kind)
     values ($1, $2, $3)`,
    [ownerUserId, operationId, event]
  );
}

function rowToRecord(row: OperationRow): SshGatewayOperationRecord {
  const result = row.safe_result === null ? undefined : safeStatus(row.safe_result, {
    operationId: row.operation_id,
    targetIdentityRevision: row.target_identity_revision
  });
  return {
    audit: {
      actorId: row.actor_id,
      actorKind: row.actor_kind,
      capability: row.capability,
      ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
      gatewayId: row.gateway_id,
      operation: row.operation,
      operationId: row.operation_id,
      outcome: outcome(row.state),
      routeClass: 'ssh_private_network',
      routeId: row.route_id,
      targetEnvironmentId: row.environment_id,
      targetIdentityRevision: row.target_identity_revision
    },
    fingerprint: row.fingerprint_sha256,
    ...(result ? { result } : {}),
    state: row.state
  };
}

function validateSafeResult(
  state: SshGatewayOperationState,
  value: SshGatewayStatusResult | undefined,
  identity: { operationId: string; targetIdentityRevision: string }
) {
  if ((state === 'succeeded') !== Boolean(value)) {
    throw new SshGatewayError('operation_conflict', 'Operation result does not match its state.');
  }
  if (value) safeStatus(value, identity);
}

function safeStatus(
  value: unknown,
  identity: { operationId: string; targetIdentityRevision: string }
): SshGatewayStatusResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResult();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join('\0');
  const expected = [
    'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
    'targetIdentityRevision', 'type'
  ].sort().join('\0');
  if (keys !== expected || record.schemaVersion !== 1 || record.type !== 'result' ||
    record.operation !== 'status.v1' || record.state !== 'ready' ||
    record.operationId !== identity.operationId || typeof record.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.checkedAt)) ||
    record.targetIdentityRevision !== identity.targetIdentityRevision) throw invalidResult();
  return record as unknown as SshGatewayStatusResult;
}

function outcome(state: SshGatewayOperationState) {
  if (state === 'succeeded') return 'succeeded' as const;
  if (state === 'uncertain' || state === 'dispatching') return 'uncertain' as const;
  if (state === 'failed' || state === 'incompatible') return 'failed' as const;
  return 'accepted' as const;
}

function invalidResult() {
  return new SshGatewayError('operation_conflict', 'Operation result is not a safe typed result.');
}
