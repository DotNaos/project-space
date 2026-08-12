import type {
  HostCapabilityRecord,
  HostConsoleFrame,
  HostConsoleInput,
  HostControlOperationResult,
  HostControlRisk,
  HostControlStatus
} from '../../src/shared/host-control-api';

export interface HostControlActor { callerMachineId?: string; userId: string }
export interface HostControlBinding {
  bindingRevision: string;
  capabilities: HostCapabilityRecord;
  machinePower?: { physicalMachineId: string };
  ownerUserId: string;
}
export interface HostControlInventory {
  resolve(ownerUserId: string, selector: string): Promise<
    | { id: string; name: string; resolution: 'resolved' }
    | { resolution: 'missing' | 'ambiguous' | 'conflict' }
  >;
}
export interface HostControlDispatchContext {
  actor: HostControlActor;
  operationId: string;
}
export interface HostControlProvider {
  input(
    binding: HostControlBinding,
    input: HostConsoleInput,
    context: HostControlDispatchContext
  ): Promise<'completed' | 'uncertain'>;
  power(
    binding: HostControlBinding,
    state: 'on' | 'off',
    context: HostControlDispatchContext
  ): Promise<'completed' | 'uncertain'>;
  screenshot(binding: HostControlBinding): Promise<HostConsoleFrame>;
  status(binding: HostControlBinding): Promise<HostControlStatus>;
}
export interface HostControlPolicyDecision {
  allowed: boolean;
  decisionId: string;
  expiresAt: string;
}
export interface HostControlPolicy {
  admit(input: { actor: HostControlActor; capability: string }): Promise<boolean>;
  authorize(input: {
    actor: HostControlActor;
    approvalId?: string;
    bindingRevision: string;
    capability: string;
    hostId: string;
    phase: 'route_resolution' | 'execution';
    risk: HostControlRisk;
  }): Promise<HostControlPolicyDecision>;
}

export interface HostControlAuditIdentity {
  actorId: string;
  actorKind: 'human' | 'machine';
  approvalId?: string;
  auditId: string;
  bindingRevision: string;
  capability: string;
  effectiveRisk: HostControlRisk;
  hostId: string;
  operationId: string;
  ownerUserId: string;
  policyDecisionId: string;
  policyExpiresAt: string;
  providerId: string;
}
export interface HostControlReservationInput {
  audit: HostControlAuditIdentity;
  attemptId: string;
  fingerprint: string;
  rateLimit: number;
  reservedAt: string;
  reservedUntil: string;
}
export type HostControlReservationResult =
  | { kind: 'new' }
  | { kind: 'replayed'; result: HostControlOperationResult }
  | { kind: 'conflict' | 'in_progress' | 'rate_limited' };
export interface HostControlOperationStore {
  finish(input: {
    audit: HostControlAuditIdentity;
    attemptId: string;
    fingerprint: string;
    result: HostControlOperationResult;
  }): Promise<void>;
  markDispatchAttempted(input: {
    audit: HostControlAuditIdentity;
    attemptId: string;
    dispatchedAt: string;
    dispatchedUntil: string;
    fingerprint: string;
  }): Promise<'fenced' | 'marked'>;
  reserve(input: HostControlReservationInput): Promise<HostControlReservationResult>;
}

export type HostControlErrorCode = 'approval_required' | 'capability_unavailable' |
  'host_conflict' | 'invalid_request' | 'operation_in_progress' | 'provider_unavailable' |
  'rate_limited' | 'replay_conflict' | 'stale_frame' | 'unauthorized';
export class HostControlError extends Error {
  constructor(readonly code: HostControlErrorCode, message: string) { super(message); }
}
