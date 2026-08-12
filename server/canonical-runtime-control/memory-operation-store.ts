import type {
  CanonicalRuntimeControlOperationRecord,
  CanonicalRuntimeControlOperationStore
} from './contracts';

export class MemoryCanonicalRuntimeControlOperationStore
implements CanonicalRuntimeControlOperationStore {
  private readonly records = new Map<string, CanonicalRuntimeControlOperationRecord>();

  async reserve(ownerUserId: string, operationId: string, fingerprint: string) {
    const key = recordKey(ownerUserId, operationId);
    const current = this.records.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint) return { kind: 'conflict' as const };
      return { kind: 'replayed' as const, record: current };
    }
    this.records.set(key, { fingerprint, state: 'dispatching' });
    return { kind: 'new' as const };
  }

  async complete(
    ownerUserId: string,
    operationId: string,
    input: { fingerprint: string; result: CanonicalRuntimeControlOperationRecord['result'] }
  ) {
    if (!input.result) throw new Error('A completed canonical operation requires a result.');
    this.records.set(recordKey(ownerUserId, operationId), {
      fingerprint: input.fingerprint,
      result: input.result,
      state: 'finished'
    });
  }

  async markUncertain(ownerUserId: string, operationId: string, fingerprint: string) {
    this.records.set(recordKey(ownerUserId, operationId), {
      fingerprint,
      state: 'uncertain'
    });
  }
}

function recordKey(ownerUserId: string, operationId: string) {
  return `${ownerUserId}\0${operationId}`;
}
