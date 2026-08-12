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
  capabilities: HostCapabilityRecord;
  ownerUserId: string;
}
export interface HostControlInventory {
  resolve(ownerUserId: string, selector: string): Promise<
    | { id: string; name: string; resolution: 'resolved' }
    | { resolution: 'missing' | 'ambiguous' | 'conflict' }
  >;
}
export interface HostControlProvider {
  input(binding: HostControlBinding, input: HostConsoleInput): Promise<void>;
  power(binding: HostControlBinding, state: 'on' | 'off'): Promise<void>;
  screenshot(binding: HostControlBinding): Promise<HostConsoleFrame>;
  status(binding: HostControlBinding): Promise<HostControlStatus>;
}
export interface HostControlPolicy {
  authorize(input: {
    actor: HostControlActor;
    approvalId?: string;
    capability: string;
    hostId: string;
    risk: HostControlRisk;
  }): Promise<boolean>;
}
export interface HostControlOperationStore {
  finish(input: {
    actor: HostControlActor;
    fingerprint: string;
    result: HostControlOperationResult;
  }): Promise<void>;
  reserve(input: {
    actor: HostControlActor;
    fingerprint: string;
    hostId: string;
    operationId: string;
  }): Promise<'new' | 'conflict' | HostControlOperationResult>;
}

export type HostControlErrorCode = 'approval_required' | 'capability_unavailable' |
  'host_conflict' | 'invalid_request' | 'provider_unavailable' | 'rate_limited' |
  'replay_conflict' | 'stale_frame' | 'unauthorized';
export class HostControlError extends Error {
  constructor(readonly code: HostControlErrorCode, message: string) { super(message); }
}
