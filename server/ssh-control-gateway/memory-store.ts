import type {
  SshGatewayOperationRecord,
  SshGatewayOperationStore
} from './contracts';
import { SshGatewayError } from './contracts';
import { validateReservation } from './store-validation';

export class MemorySshGatewayOperationStore implements SshGatewayOperationStore {
  private readonly records = new Map<string, SshGatewayOperationRecord>();
  private readonly activeTargets = new Map<string, string>();

  async reserve(input: Parameters<SshGatewayOperationStore['reserve']>[0]) {
    validateReservation(input);
    const key = `${input.ownerUserId}:${input.operationId}`;
    const current = this.records.get(key);
    if (current) {
      if (current.fingerprint !== input.fingerprint) {
        throw new SshGatewayError('operation_conflict', 'Operation identity was reused for different input.');
      }
      return { record: structuredClone(current), replayed: true };
    }
    const targetKey = `${input.ownerUserId}:${input.targetEnvironmentId}`;
    if (this.activeTargets.has(targetKey)) {
      throw new SshGatewayError('operation_in_progress', 'Another operation fences this target.');
    }
    const record: SshGatewayOperationRecord = {
      audit: structuredClone(input.audit),
      fingerprint: input.fingerprint,
      state: 'reserved'
    };
    this.records.set(key, record);
    this.activeTargets.set(targetKey, key);
    return { record: structuredClone(record), replayed: false };
  }

  async markDispatchAttempted(input: Parameters<SshGatewayOperationStore['markDispatchAttempted']>[0]) {
    const record = this.records.get(`${input.ownerUserId}:${input.operationId}`);
    if (!record || record.fingerprint !== input.fingerprint || record.state !== 'reserved') {
      throw new SshGatewayError('operation_conflict', 'Operation cannot be dispatched.');
    }
    record.state = 'dispatching';
  }

  async complete(input: Parameters<SshGatewayOperationStore['complete']>[0]) {
    const key = `${input.ownerUserId}:${input.operationId}`;
    const current = this.records.get(key);
    const requiresDispatch = ['succeeded', 'incompatible', 'uncertain'].includes(input.state);
    if (!current || current.fingerprint !== input.fingerprint ||
      !['reserved', 'dispatching'].includes(current.state) ||
      (requiresDispatch && current.state !== 'dispatching')) {
      throw new SshGatewayError('operation_conflict', 'Operation cannot transition from its current state.');
    }
    if ((input.state === 'succeeded' || input.state === 'uncertain') &&
      current.state !== 'dispatching') {
      throw new SshGatewayError('operation_conflict', 'Operation was not dispatched.');
    }
    assertResultBinding(current, input.result, input.state);
    const record: SshGatewayOperationRecord = {
      ...current,
      audit: completedAudit(current.audit, input.audit, input.state),
      ...(input.result ? { result: input.result } : {}),
      state: input.state
    };
    this.records.set(key, record);
    if (input.state !== 'uncertain') {
      this.activeTargets.delete(`${input.ownerUserId}:${record.audit.targetEnvironmentId}`);
    }
    return structuredClone(record);
  }

  async reconcile(input: Parameters<SshGatewayOperationStore['reconcile']>[0]) {
    const key = `${input.ownerUserId}:${input.operationId}`;
    const current = this.records.get(key);
    if (!current || current.fingerprint !== input.fingerprint ||
      !['dispatching', 'uncertain'].includes(current.state)) {
      throw new SshGatewayError('operation_conflict', 'Operation cannot be reconciled.');
    }
    assertResultBinding(current, input.result, input.state);
    const record: SshGatewayOperationRecord = {
      ...current,
      audit: completedAudit(current.audit, input.audit, input.state),
      ...(input.result ? { result: input.result } : {}),
      state: input.state
    };
    this.records.set(key, record);
    this.activeTargets.delete(`${input.ownerUserId}:${record.audit.targetEnvironmentId}`);
    return structuredClone(record);
  }
}

function completedAudit(
  current: SshGatewayOperationRecord['audit'],
  input: SshGatewayOperationRecord['audit'],
  state: SshGatewayOperationRecord['state']
): SshGatewayOperationRecord['audit'] {
  return {
    ...current,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    outcome: state === 'succeeded' ? 'succeeded' : 'failed'
  };
}

function assertResultBinding(
  record: SshGatewayOperationRecord,
  result: Parameters<SshGatewayOperationStore['complete']>[0]['result'],
  state: string
) {
  if ((state === 'succeeded') !== Boolean(result) ||
    (result && (result.operationId !== record.audit.operationId ||
      result.targetIdentityRevision !== record.audit.targetIdentityRevision))) {
    throw new SshGatewayError('operation_conflict', 'Operation result does not match its reservation.');
  }
}
