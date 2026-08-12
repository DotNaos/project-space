import { createHash, randomUUID } from 'node:crypto';

import {
  hostControlSchemaVersion,
  type HostConsoleFrame,
  type HostConsoleInput,
  type HostControlOperationRequest,
  type HostControlOperationResult,
  type HostControlRisk
} from '../../src/shared/host-control-api';
import {
  HostControlError,
  type HostControlActor,
  type HostControlAuditIdentity,
  type HostControlBinding,
  type HostControlInventory,
  type HostControlOperationStore,
  type HostControlPolicy,
  type HostControlPolicyDecision,
  type HostControlProvider,
  type HostControlReservationInput
} from './contracts';
import { validFrame } from './png';

export { MemoryHostControlOperationStore } from './memory-store';
export { pngDimensions } from './png';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;
const risks = new Set<HostControlRisk>([
  'standard', 'boot', 'disk', 'firmware', 'installer', 'recovery', 'secure_boot'
]);
const riskRank: Record<HostControlRisk, number> = {
  standard: 0, boot: 1, recovery: 2, installer: 3, disk: 4, secure_boot: 5, firmware: 6
};
const reservationLeaseMs = 30_000;
const maximumBindingAgeMs = 90_000;

export function createHostControlService(options: {
  bindings(): Promise<HostControlBinding[]>;
  inventory: HostControlInventory;
  operations: HostControlOperationStore;
  policy: HostControlPolicy;
  provider: HostControlProvider;
  now?: () => Date;
  rateLimit?: number;
}) {
  const now = options.now ?? (() => new Date());

  async function admit(actor: HostControlActor, capability: string) {
    if (!actor.userId || !await options.policy.admit({ actor, capability })) {
      throw new HostControlError('unauthorized', 'Host control policy denied this capability.');
    }
  }

  async function target(actor: HostControlActor, selector: string) {
    if (!selectorPattern.test(selector)) throw invalid();
    const host = await options.inventory.resolve(actor.userId, selector);
    if (host.resolution !== 'resolved') {
      throw new HostControlError('host_conflict', 'One exact resolved Host is required.');
    }
    const bindings = (await options.bindings()).filter((entry) =>
      entry.ownerUserId === actor.userId && entry.capabilities.hostId === host.id
    );
    if (bindings.length !== 1) {
      throw new HostControlError('capability_unavailable',
        bindings.length ? 'Host control binding is ambiguous.' : 'Host has no control binding.');
    }
    return { binding: bindings[0]!, host };
  }

  async function authorize(input: {
    actor: HostControlActor;
    approvalId?: string;
    binding: HostControlBinding;
    capability: string;
    phase: 'route_resolution' | 'execution';
    risk: HostControlRisk;
  }) {
    if (input.risk !== 'standard' && !input.approvalId) {
      throw new HostControlError('approval_required', 'This Host action requires explicit approval.');
    }
    const decision = await options.policy.authorize({
      actor: input.actor,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      bindingRevision: input.binding.bindingRevision,
      capability: input.capability,
      hostId: input.binding.capabilities.hostId,
      phase: input.phase,
      risk: input.risk
    });
    validateDecision(decision, now());
    return decision;
  }

  async function retarget(
    actor: HostControlActor,
    selector: string,
    expected: HostControlBinding
  ) {
    const current = await target(actor, selector);
    if (current.binding.bindingRevision !== expected.bindingRevision ||
      current.binding.capabilities.provider.id !== expected.capabilities.provider.id) {
      throw new HostControlError('host_conflict', 'Host control binding changed before execution.');
    }
    return current.binding;
  }

  return {
    async status(actor: HostControlActor, selector: string) {
      const capability = 'host.status';
      await admit(actor, capability);
      const { binding } = await target(actor, selector);
      await authorize({ actor, binding, capability, phase: 'route_resolution', risk: 'standard' });
      const current = await retarget(actor, selector, binding);
      await authorize({ actor, binding: current, capability, phase: 'execution', risk: 'standard' });
      const status = await options.provider.status(current);
      if (!validStatus(status, current, now(), false)) {
        throw new HostControlError('provider_unavailable', 'Host status evidence is invalid.');
      }
      return statusProjection(status);
    },

    async screenshot(actor: HostControlActor, selector: string) {
      const capability = 'host.console.screenshot';
      await admit(actor, capability);
      const { binding } = await target(actor, selector);
      if (!binding.capabilities.console.includes('screenshot')) unavailable();
      await authorize({ actor, binding, capability, phase: 'route_resolution', risk: 'standard' });
      const current = await retarget(actor, selector, binding);
      await authorize({ actor, binding: current, capability, phase: 'execution', risk: 'standard' });
      const frame = await options.provider.screenshot(current);
      if (!validFrame(frame, now())) unavailable('Console frame is invalid.');
      return frame;
    },

    async operate(actor: HostControlActor, selector: string, request: HostControlOperationRequest) {
      validateRequest(request);
      const capability = request.input
        ? `host.console.${request.input.kind}`
        : `host.power.${request.powerState}`;
      const risk = inferredRisk(request.input, request.powerState, request.risk);
      await admit(actor, capability);
      const { binding } = await target(actor, selector);
      if ((request.input && !binding.capabilities.console.includes(request.input.kind)) ||
        (request.powerState && !binding.capabilities.power.includes(request.powerState))) unavailable();
      const first = await authorize({
        actor, approvalId: request.approvalId, binding, capability,
        phase: 'route_resolution', risk
      });
      const audit = auditIdentity(actor, binding, request, capability, risk, first);
      const fingerprint = operationFingerprint(audit, request);
      const reservedAt = now();
      const reservation: HostControlReservationInput = {
        audit,
        attemptId: randomUUID(),
        fingerprint,
        rateLimit: options.rateLimit ?? 30,
        reservedAt: reservedAt.toISOString(),
        reservedUntil: new Date(reservedAt.getTime() + reservationLeaseMs).toISOString()
      };
      const reserved = await options.operations.reserve(reservation);
      if (reserved.kind === 'conflict') replayConflict();
      if (reserved.kind === 'replayed') return { ...reserved.result, replayed: true };
      if (reserved.kind === 'rate_limited') {
        throw new HostControlError('rate_limited', 'Host console input rate limit exceeded.');
      }
      if (reserved.kind === 'in_progress') {
        throw new HostControlError('operation_in_progress', 'Host operation is already reserved.');
      }

      if (request.input && 'frameId' in request.input) {
        let frame: HostConsoleFrame;
        try {
          frame = await options.provider.screenshot(binding);
        } catch {
          return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
            operationResult(audit, now(), 'failed', 'provider_unavailable',
              'Console frame preflight failed before dispatch.'));
        }
        if (!validFrame(frame, now()) || frame.frameId !== request.input.frameId ||
          request.input.x < 0 || request.input.y < 0 ||
          request.input.x >= frame.width || request.input.y >= frame.height) {
          return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
            operationResult(audit, now(), 'rejected', 'stale_frame',
              'The referenced console frame or coordinates are no longer valid.'));
        }
      }

      let current: HostControlBinding;
      try {
        current = await retarget(actor, selector, binding);
        const status = await options.provider.status(current);
        if (!validStatus(status, current, now(), true)) unavailable('Host control evidence is stale.');
        const second = await authorize({
          actor, approvalId: request.approvalId, binding: current, capability,
          phase: 'execution', risk
        });
        if (second.decisionId !== first.decisionId) {
          throw new HostControlError('unauthorized', 'Host control approval changed before execution.');
        }
        validateDecision(second, now());
        audit.policyExpiresAt = second.expiresAt;
      } catch (error) {
        if (error instanceof HostControlError &&
          (error.code === 'approval_required' || error.code === 'unauthorized')) {
          return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
            operationResult(audit, now(), 'rejected', 'unauthorized',
              'Host control authorization changed before dispatch.'));
        }
        return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
          operationResult(audit, now(), 'failed', 'provider_unavailable',
            'Host control preflight failed before dispatch.'));
      }

      const dispatchedAt = now();
      if (await options.operations.markDispatchAttempted({
        audit,
        attemptId: reservation.attemptId,
        dispatchedAt: dispatchedAt.toISOString(),
        dispatchedUntil: new Date(dispatchedAt.getTime() + reservationLeaseMs).toISOString(),
        fingerprint
      }) === 'fenced') {
        throw new HostControlError('operation_in_progress', 'Another Host operation is already being dispatched.');
      }
      try {
        const outcome = request.input
          ? await options.provider.input(current, request.input, { actor, operationId: request.operationId })
          : await options.provider.power(current, request.powerState!, { actor, operationId: request.operationId });
        return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
          operationResult(audit, now(), outcome === 'completed' ? 'completed' : 'uncertain',
            outcome === 'completed' ? undefined : 'provider_unavailable',
            outcome === 'completed'
              ? 'Host operation completed.'
              : 'Host operation may have completed and will not be sent again.'));
      } catch {
        return finishResult(options.operations, audit, reservation.attemptId, fingerprint,
          operationResult(audit, now(), 'uncertain', 'provider_unavailable',
            'Host operation may have completed and will not be sent again.'));
      }
    }
  };
}

function validateDecision(decision: HostControlPolicyDecision, now: Date) {
  if (!decision.allowed || !operationIdPattern.test(decision.decisionId) ||
    !Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt) <= now.getTime()) {
    throw new HostControlError('unauthorized', 'Host control policy denied this action.');
  }
}

function auditIdentity(
  actor: HostControlActor,
  binding: HostControlBinding,
  request: HostControlOperationRequest,
  capability: string,
  risk: HostControlRisk,
  decision: HostControlPolicyDecision
): HostControlAuditIdentity {
  return {
    actorId: actor.callerMachineId ?? actor.userId,
    actorKind: actor.callerMachineId ? 'machine' : 'human',
    ...(request.approvalId ? { approvalId: request.approvalId } : {}),
    auditId: auditUuid(actor.userId, request.operationId),
    bindingRevision: binding.bindingRevision,
    capability,
    effectiveRisk: risk,
    hostId: binding.capabilities.hostId,
    operationId: request.operationId,
    ownerUserId: actor.userId,
    policyDecisionId: decision.decisionId,
    policyExpiresAt: decision.expiresAt,
    providerId: binding.capabilities.provider.id
  };
}

function auditUuid(ownerUserId: string, operationId: string) {
  const bytes = createHash('sha256').update(`host-control:${ownerUserId}:${operationId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inferredRisk(
  input: HostConsoleInput | undefined,
  powerState: 'on' | 'off' | undefined,
  requested: HostControlRisk
) {
  const minimum: HostControlRisk = input ? 'boot' : powerState === 'off' ? 'boot' : 'standard';
  return riskRank[requested] >= riskRank[minimum] ? requested : minimum;
}

function operationFingerprint(audit: HostControlAuditIdentity, request: HostControlOperationRequest) {
  return createHash('sha256').update(JSON.stringify([
    audit.actorKind, audit.actorId, audit.ownerUserId, audit.hostId, audit.bindingRevision,
    audit.providerId, audit.capability, audit.effectiveRisk, audit.approvalId ?? null,
    audit.policyDecisionId, canonicalInput(request.input), request.powerState ?? null
  ])).digest('hex');
}

function canonicalInput(input: HostConsoleInput | undefined) {
  if (!input) return null;
  if (input.kind === 'key') return ['key', input.key];
  if (input.kind === 'chord') return ['chord', ...input.keys];
  if (input.kind === 'text') return ['text', input.text];
  if (input.kind === 'mouse_move') return ['mouse_move', input.frameId, input.x, input.y];
  return ['mouse_click', input.frameId, input.x, input.y, input.button];
}

function operationResult(
  audit: HostControlAuditIdentity,
  completedAt: Date,
  state: HostControlOperationResult['state'],
  code: HostControlOperationResult['code'],
  message: string
): HostControlOperationResult {
  return {
    auditId: audit.auditId,
    ...(code ? { code } : {}),
    completedAt: completedAt.toISOString(),
    hostId: audit.hostId,
    message,
    operationId: audit.operationId,
    provider: { id: audit.providerId, kind: 'jetkvm' },
    replayed: false,
    schemaVersion: hostControlSchemaVersion,
    state
  };
}

async function finishResult(
  operations: HostControlOperationStore,
  audit: HostControlAuditIdentity,
  attemptId: string,
  fingerprint: string,
  result: HostControlOperationResult
) {
  await operations.finish({ audit, attemptId, fingerprint, result });
  return result;
}

function validateRequest(request: HostControlOperationRequest) {
  if (!request || typeof request !== 'object' ||
    Object.keys(request).some((key) => !['approvalId', 'input', 'operationId', 'powerState', 'risk'].includes(key)) ||
    !operationIdPattern.test(request.operationId) || !risks.has(request.risk) ||
    request.approvalId !== undefined && !operationIdPattern.test(request.approvalId) ||
    Number(Boolean(request.input)) + Number(Boolean(request.powerState)) !== 1) throw invalid();
  if (request.powerState && request.powerState !== 'on' && request.powerState !== 'off') throw invalid();
  if (!request.input) return;
  const allowed = request.input.kind === 'key' ? ['key', 'kind']
    : request.input.kind === 'chord' ? ['keys', 'kind']
      : request.input.kind === 'text' ? ['kind', 'text']
        : request.input.kind === 'mouse_move' ? ['frameId', 'kind', 'x', 'y']
          : request.input.kind === 'mouse_click' ? ['button', 'frameId', 'kind', 'x', 'y'] : [];
  if (!allowed.length || Object.keys(request.input).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !(key in request.input!))) throw invalid();
  if (request.input.kind === 'key' && !keyPattern.test(request.input.key) ||
    request.input.kind === 'chord' && (request.input.keys.length < 2 ||
      request.input.keys.length > 8 || request.input.keys.some((key) => !keyPattern.test(key))) ||
    request.input.kind === 'text' && (!request.input.text || request.input.text.length > 4096 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.input.text)) ||
    'frameId' in request.input && (!operationIdPattern.test(request.input.frameId) ||
      !Number.isSafeInteger(request.input.x) || !Number.isSafeInteger(request.input.y)) ||
    request.input.kind === 'mouse_click' && !['left', 'middle', 'right'].includes(request.input.button)) throw invalid();
}

function validStatus(
  status: Awaited<ReturnType<HostControlProvider['status']>>,
  binding: HostControlBinding,
  now: Date,
  requireReady: boolean
) {
  const expected = binding.capabilities;
  const verifiedAt = status.lastVerifiedAt ? Date.parse(status.lastVerifiedAt) : Number.NaN;
  const matching = status.schemaVersion === hostControlSchemaVersion && status.hostId === expected.hostId &&
    status.provider.kind === 'jetkvm' && status.provider.id === expected.provider.id &&
    ['on', 'off', 'unknown'].includes(status.powerState) &&
    status.power.every((capability) => expected.power.includes(capability)) &&
    status.console.every((capability) => expected.console.includes(capability));
  return matching && (!requireReady || status.available && Number.isFinite(verifiedAt) &&
    verifiedAt <= now.getTime() && verifiedAt >= now.getTime() - maximumBindingAgeMs);
}

function statusProjection(status: Awaited<ReturnType<HostControlProvider['status']>>) {
  return {
    available: status.available,
    console: [...status.console],
    hostId: status.hostId,
    ...(status.lastVerifiedAt ? { lastVerifiedAt: status.lastVerifiedAt } : {}),
    power: [...status.power],
    powerState: status.powerState,
    provider: { id: status.provider.id, kind: status.provider.kind },
    schemaVersion: status.schemaVersion
  };
}

function invalid() { return new HostControlError('invalid_request', 'Host control request is invalid.'); }
function unavailable(message = 'Host capability is not configured.'): never {
  throw new HostControlError('capability_unavailable', message);
}
function replayConflict(): never {
  throw new HostControlError('replay_conflict', 'Operation replay changed.');
}
