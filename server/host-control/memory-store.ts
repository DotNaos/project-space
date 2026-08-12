import type { HostControlOperationResult } from '../../src/shared/host-control-api';
import type {
  HostControlAuditIdentity,
  HostControlOperationStore,
  HostControlReservationInput
} from './contracts';

const reservationLeaseMs = 30_000;

export class MemoryHostControlOperationStore implements HostControlOperationStore {
  private readonly values = new Map<string, {
    audit: HostControlAuditIdentity;
    attemptId: string;
    fingerprint: string;
    reservedUntil: string;
    result?: HostControlOperationResult;
    state: 'dispatching' | 'reserved' | 'terminal';
  }>();

  async reserve(input: HostControlReservationInput) {
    const key = `${input.audit.ownerUserId}\0${input.audit.operationId}`;
    const prior = this.values.get(key);
    if (prior) {
      if (prior.fingerprint !== input.fingerprint || !sameAudit(prior.audit, input.audit)) {
        return { kind: 'conflict' as const };
      }
      if (prior.result) return { kind: 'replayed' as const, result: structuredClone(prior.result) };
      if (prior.state === 'dispatching') {
        if (Date.parse(prior.reservedUntil) > Date.parse(input.reservedAt)) {
          return { kind: 'in_progress' as const };
        }
        const result = abandonedDispatchResult(prior.audit, input.reservedAt);
        prior.result = result;
        prior.state = 'terminal';
        return { kind: 'replayed' as const, result };
      }
      if (Date.parse(prior.reservedUntil) > Date.parse(input.reservedAt)) {
        return { kind: 'in_progress' as const };
      }
      prior.audit.policyExpiresAt = input.audit.policyExpiresAt;
      prior.attemptId = input.attemptId;
      prior.reservedUntil = input.reservedUntil;
      return { kind: 'new' as const };
    }
    const cutoff = Date.parse(input.reservedAt) - 60_000;
    const count = [...this.values.values()].filter((entry) =>
      entry.audit.ownerUserId === input.audit.ownerUserId && entry.audit.hostId === input.audit.hostId &&
      entry.audit.capability.startsWith('host.console.') && Date.parse(entry.reservedUntil) - reservationLeaseMs > cutoff
    ).length;
    if (input.audit.capability.startsWith('host.console.') && count >= input.rateLimit) {
      return { kind: 'rate_limited' as const };
    }
    this.values.set(key, {
      audit: structuredClone(input.audit), attemptId: input.attemptId, fingerprint: input.fingerprint,
      reservedUntil: input.reservedUntil, state: 'reserved'
    });
    return { kind: 'new' as const };
  }

  async markDispatchAttempted(input: {
    audit: HostControlAuditIdentity; attemptId: string; dispatchedAt: string;
    dispatchedUntil: string; fingerprint: string;
  }) {
    const record = this.require(input);
    for (const entry of this.values.values()) {
      if (entry.state === 'dispatching' && entry.audit.ownerUserId === input.audit.ownerUserId &&
        entry.audit.hostId === input.audit.hostId &&
        Date.parse(entry.reservedUntil) <= Date.parse(input.dispatchedAt)) {
        entry.result = abandonedDispatchResult(entry.audit, input.dispatchedAt);
        entry.state = 'terminal';
      }
    }
    if ([...this.values.values()].some((entry) => entry !== record && entry.state === 'dispatching' &&
      entry.audit.ownerUserId === input.audit.ownerUserId && entry.audit.hostId === input.audit.hostId)) {
      return 'fenced' as const;
    }
    if (record.state !== 'reserved' || record.attemptId !== input.attemptId ||
      Date.parse(record.reservedUntil) <= Date.parse(input.dispatchedAt) ||
      Date.parse(input.audit.policyExpiresAt) <= Date.parse(input.dispatchedAt)) return 'fenced' as const;
    record.audit.policyExpiresAt = input.audit.policyExpiresAt;
    record.reservedUntil = input.dispatchedUntil;
    record.state = 'dispatching';
    return 'marked' as const;
  }

  async finish(input: {
    audit: HostControlAuditIdentity; attemptId: string; fingerprint: string; result: HostControlOperationResult;
  }) {
    const record = this.require(input);
    if (record.attemptId !== input.attemptId) throw new Error('Host audit attempt changed.');
    if (record.result) {
      if (JSON.stringify(record.result) !== JSON.stringify(input.result)) throw new Error('Host audit changed.');
      return;
    }
    if (input.result.state === 'completed' && record.state !== 'dispatching') {
      throw new Error('Completed Host operation was not dispatched.');
    }
    record.result = structuredClone(input.result);
    record.state = 'terminal';
  }

  private require(input: { audit: HostControlAuditIdentity; fingerprint: string }) {
    const record = this.values.get(`${input.audit.ownerUserId}\0${input.audit.operationId}`);
    if (!record || record.fingerprint !== input.fingerprint || !sameAudit(record.audit, input.audit)) {
      throw new Error('Host audit reservation changed.');
    }
    return record;
  }
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

function sameAudit(left: HostControlAuditIdentity, right: HostControlAuditIdentity) {
  const { policyExpiresAt: _leftExpiry, ...leftIdentity } = left;
  const { policyExpiresAt: _rightExpiry, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}
