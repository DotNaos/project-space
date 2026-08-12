import type { HostControlOperationResult } from '../../src/shared/host-control-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  HostControlAuditIdentity,
  HostControlOperationStore,
  HostControlReservationInput
} from './contracts';

interface OperationRow {
  actor_id: string;
  actor_kind: HostControlAuditIdentity['actorKind'];
  approval_id: string | null;
  attempt_id: string;
  audit_id: string;
  binding_revision: string;
  capability: string;
  completed_at: Date | string | null;
  dispatch_attempted: boolean;
  effective_risk: HostControlAuditIdentity['effectiveRisk'];
  fingerprint_sha256: string;
  host_id: string;
  operation_id: string;
  owner_user_id: string;
  policy_decision_id: string;
  policy_expires_at: Date | string;
  provider_id: string;
  reserved_until: Date | string;
  result_code: HostControlOperationResult['code'] | null;
  result_message: string | null;
  state: 'reserved' | 'dispatching' | HostControlOperationResult['state'];
}

const returning = `owner_user_id, operation_id, host_id::text, actor_kind, actor_id,
  capability, effective_risk, approval_id, policy_decision_id, policy_expires_at,
  provider_id, binding_revision, fingerprint_sha256, audit_id::text, attempt_id::text, state,
  result_code, result_message, reserved_until, dispatch_attempted, completed_at`;

export class PostgresHostControlOperationStore implements HostControlOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {
    if (!client.transaction) throw new Error('Host control operations require transactions.');
  }

  reserve(input: HostControlReservationInput) {
    return this.client.transaction!(async (client) => {
      await lockOperation(client, input.audit.ownerUserId, input.audit.operationId);
      await lockHost(client, input.audit.ownerUserId, input.audit.hostId);
      const legacy = await client.query<{ present: number }>(
        `select 1 as present from host_control_operations_v1_retained
          where owner_user_id = $1 and operation_id = $2 limit 1`,
        [input.audit.ownerUserId, input.audit.operationId]
      );
      if (legacy.rows.length) return { kind: 'conflict' as const };
      const prior = await client.query<OperationRow>(
        `select ${returning} from host_control_operations
          where owner_user_id = $1 and operation_id = $2 for update`,
        [input.audit.ownerUserId, input.audit.operationId]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.fingerprint_sha256 !== input.fingerprint || !sameAudit(row, input.audit)) {
          return { kind: 'conflict' as const };
        }
        const result = resultFrom(row);
        if (result) return { kind: 'replayed' as const, result };
        if (row.state === 'dispatching') {
          if (Date.parse(iso(row.reserved_until)) > Date.parse(input.reservedAt)) {
            return { kind: 'in_progress' as const };
          }
          const result = abandonedDispatchResult(input.audit, input.reservedAt);
          const reconciled = await client.query(
            `update host_control_operations
                set state = 'uncertain', result_code = 'provider_unavailable',
                    result_message = $3, completed_at = $4::timestamptz
              where owner_user_id = $1 and operation_id = $2 and state = 'dispatching' and
                    attempt_id = $5::uuid`,
            [input.audit.ownerUserId, input.audit.operationId, result.message,
              input.reservedAt, row.attempt_id]
          );
          if (reconciled.rowCount !== 1) return { kind: 'in_progress' as const };
          return { kind: 'replayed' as const, result };
        }
        if (Date.parse(iso(row.reserved_until)) > Date.parse(input.reservedAt)) {
          return { kind: 'in_progress' as const };
        }
        await client.query(
          `update host_control_operations set reserved_until = $3::timestamptz,
              policy_expires_at = $4::timestamptz, attempt_id = $5::uuid
            where owner_user_id = $1 and operation_id = $2 and state = 'reserved'`,
          [input.audit.ownerUserId, input.audit.operationId, input.reservedUntil,
            input.audit.policyExpiresAt, input.attemptId]
        );
        return { kind: 'new' as const };
      }
      if (input.audit.capability.startsWith('host.console.')) {
        const rate = await client.query<{ count: string }>(
          `select count(*)::text as count from host_control_operations
            where owner_user_id = $1 and host_id = $2::uuid and
                  capability like 'host.console.%' and created_at > $3::timestamptz - interval '1 minute'`,
          [input.audit.ownerUserId, input.audit.hostId, input.reservedAt]
        );
        if (Number(rate.rows[0]?.count ?? 0) >= input.rateLimit) {
          return { kind: 'rate_limited' as const };
        }
      }
      await client.query(
        `insert into host_control_operations (
           owner_user_id, operation_id, host_id, actor_kind, actor_id, capability,
           effective_risk, approval_id, policy_decision_id, policy_expires_at,
           provider_id, binding_revision, fingerprint_sha256, audit_id, attempt_id,
           reserved_until, created_at
         ) values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::timestamptz,
                   $11, $12, $13, $14::uuid, $15::uuid, $16::timestamptz, $17::timestamptz)`,
        values(input, input.reservedAt)
      );
      return { kind: 'new' as const };
    });
  }

  markDispatchAttempted(input: {
    audit: HostControlAuditIdentity; attemptId: string; dispatchedAt: string;
    dispatchedUntil: string; fingerprint: string;
  }) {
    return this.client.transaction!(async (client) => {
      await lockHost(client, input.audit.ownerUserId, input.audit.hostId);
      await client.query(
        `update host_control_operations
            set state = 'uncertain', result_code = 'provider_unavailable',
                result_message = 'A previous dispatch may have completed and will not be sent again.',
                completed_at = $3::timestamptz
          where owner_user_id = $1 and host_id = $2::uuid and state = 'dispatching' and
                reserved_until <= $3::timestamptz`,
        [input.audit.ownerUserId, input.audit.hostId, input.dispatchedAt]
      );
      const active = await client.query<{ operation_id: string }>(
        `select operation_id from host_control_operations
          where owner_user_id = $1 and host_id = $2::uuid and state = 'dispatching' limit 1`,
        [input.audit.ownerUserId, input.audit.hostId]
      );
      if (active.rows.length) return 'fenced' as const;
      const updated = await client.query(
        `update host_control_operations set state = 'dispatching', dispatch_attempted = true,
            policy_expires_at = $6::timestamptz, reserved_until = $8::timestamptz
          where owner_user_id = $1 and operation_id = $2 and fingerprint_sha256 = $3 and
                binding_revision = $4 and state = 'reserved' and attempt_id = $5::uuid and
                reserved_until > $7::timestamptz and $6::timestamptz > $7::timestamptz`,
        [input.audit.ownerUserId, input.audit.operationId, input.fingerprint,
          input.audit.bindingRevision, input.attemptId, input.audit.policyExpiresAt,
          input.dispatchedAt, input.dispatchedUntil]
      );
      return updated.rowCount === 1 ? 'marked' as const : 'fenced' as const;
    });
  }

  async finish(input: {
    audit: HostControlAuditIdentity; attemptId: string; fingerprint: string; result: HostControlOperationResult;
  }) {
    validateResult(input.audit, input.result);
    const updated = await this.client.query(
      `update host_control_operations
          set state = $4, result_code = $5, result_message = $6,
              completed_at = $7::timestamptz
        where owner_user_id = $1 and operation_id = $2 and fingerprint_sha256 = $3 and
              host_id = $8::uuid and actor_kind = $9 and actor_id = $10 and
              binding_revision = $11 and provider_id = $12 and capability = $13 and
              effective_risk = $14 and policy_decision_id = $15 and
              attempt_id = $16::uuid and
              state in ('reserved', 'dispatching') and
              ($4 <> 'completed' or state = 'dispatching')`,
      [input.audit.ownerUserId, input.audit.operationId, input.fingerprint,
        input.result.state, input.result.code ?? null, input.result.message,
        input.result.completedAt, input.audit.hostId, input.audit.actorKind,
        input.audit.actorId, input.audit.bindingRevision, input.audit.providerId,
        input.audit.capability, input.audit.effectiveRisk, input.audit.policyDecisionId,
        input.attemptId]
    );
    if (updated.rowCount !== 1) throw new Error('Host control audit reservation changed.');
  }
}

function values(input: HostControlReservationInput, createdAt: string) {
  const audit = input.audit;
  return [audit.ownerUserId, audit.operationId, audit.hostId, audit.actorKind, audit.actorId,
    audit.capability, audit.effectiveRisk, audit.approvalId ?? null, audit.policyDecisionId,
    audit.policyExpiresAt, audit.providerId, audit.bindingRevision, input.fingerprint,
    audit.auditId, input.attemptId, input.reservedUntil, createdAt];
}

function abandonedDispatchResult(
  audit: HostControlAuditIdentity,
  completedAt: string
): HostControlOperationResult {
  return {
    auditId: audit.auditId,
    code: 'provider_unavailable',
    completedAt,
    hostId: audit.hostId,
    message: 'A previous dispatch may have completed and will not be sent again.',
    operationId: audit.operationId,
    provider: { id: audit.providerId, kind: 'jetkvm' },
    replayed: false,
    schemaVersion: 1,
    state: 'uncertain'
  };
}

function sameAudit(row: OperationRow, audit: HostControlAuditIdentity) {
  return row.owner_user_id === audit.ownerUserId && row.operation_id === audit.operationId &&
    row.audit_id === audit.auditId &&
    row.host_id === audit.hostId && row.actor_kind === audit.actorKind && row.actor_id === audit.actorId &&
    row.capability === audit.capability && row.effective_risk === audit.effectiveRisk &&
    row.approval_id === (audit.approvalId ?? null) && row.policy_decision_id === audit.policyDecisionId &&
    row.provider_id === audit.providerId && row.binding_revision === audit.bindingRevision;
}

function resultFrom(row: OperationRow): HostControlOperationResult | undefined {
  if (row.state === 'reserved' || row.state === 'dispatching') return undefined;
  if (!row.completed_at || !row.result_message || !row.audit_id ||
    !validTerminalCode(row.state, row.result_code) ||
    row.state === 'uncertain' && !row.dispatch_attempted) throw new Error('Host audit result is invalid.');
  return {
    auditId: row.audit_id,
    ...(row.result_code ? { code: row.result_code } : {}),
    completedAt: iso(row.completed_at),
    hostId: row.host_id,
    message: row.result_message,
    operationId: row.operation_id,
    provider: { id: row.provider_id, kind: 'jetkvm' },
    replayed: false,
    schemaVersion: 1,
    state: row.state
  };
}

function validateResult(audit: HostControlAuditIdentity, result: HostControlOperationResult) {
  if (result.schemaVersion !== 1 || result.operationId !== audit.operationId ||
    result.auditId !== audit.auditId ||
    result.hostId !== audit.hostId || result.provider.kind !== 'jetkvm' ||
    result.provider.id !== audit.providerId || !validTerminalCode(result.state, result.code ?? null) ||
    !result.message || result.message.length > 512 || /[\u0000-\u001f\u007f]/.test(result.message) ||
    !Number.isFinite(Date.parse(result.completedAt)) || result.replayed) {
    throw new Error('Host audit result is invalid.');
  }
}

function validTerminalCode(
  state: HostControlOperationResult['state'],
  code: HostControlOperationResult['code'] | null
) {
  return state === 'completed' ? code === null
    : state === 'failed' || state === 'uncertain' ? code === 'provider_unavailable'
      : code === 'operation_in_progress' || code === 'stale_frame' || code === 'unauthorized';
}

function lockOperation(client: DatabaseQueryClient, ownerUserId: string, operationId: string) {
  return client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `host-control-operation:${ownerUserId}:${operationId}`
  ]);
}
function lockHost(client: DatabaseQueryClient, ownerUserId: string, hostId: string) {
  return client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `host-control-host:${ownerUserId}:${hostId}`
  ]);
}
function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : value; }
