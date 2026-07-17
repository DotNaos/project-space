import type { CodexOperationSnapshot } from './contracts';
import { validateIdentifier } from './validation';

type StoredOperation = {
  fingerprint: string;
  promise?: Promise<unknown>;
  result?: unknown;
  state: 'completed' | 'completing' | 'pending' | 'removing' | 'uncertain';
};

export type CodexOperationSnapshotPersist = (
  snapshot: CodexOperationSnapshot
) => Promise<void>;

const noopPersist: CodexOperationSnapshotPersist = async () => {};

export class CodexOperationConflictError extends Error {
  readonly code = 'codex_operation_conflict';
}

export class CodexOperationUncertainError extends Error {
  readonly code = 'codex_operation_uncertain';
}

export class CodexOperationLedger {
  private persistenceTail = Promise.resolve();
  private readonly records = new Map<string, StoredOperation>();

  constructor(
    snapshot: CodexOperationSnapshot = [],
    private readonly persist: CodexOperationSnapshotPersist = noopPersist
  ) {
    for (const entry of snapshot) {
      const operationId = validateIdentifier(entry.operationId, 'operationId');
      if (this.records.has(operationId)) {
        throw new Error(`The operation snapshot contains duplicate id ${operationId}.`);
      }
      if (typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) {
        throw new Error(`The operation snapshot contains an invalid fingerprint for ${operationId}.`);
      }
      if (entry.state !== 'completed' && entry.state !== 'uncertain') {
        throw new Error(`The operation snapshot contains an invalid state for ${operationId}.`);
      }
      this.records.set(operationId, {
        fingerprint: entry.fingerprint,
        result: entry.result,
        state: entry.state
      });
    }
  }

  execute<Result>(operationId: string, fingerprint: string, action: () => Promise<Result>) {
    validateIdentifier(operationId, 'operationId');
    const previous = this.records.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CodexOperationConflictError('The operation id was already used for different input.');
      }
      if (
        previous.state === 'uncertain' ||
        previous.state === 'removing' ||
        (previous.state === 'completing' && !previous.promise)
      ) {
        throw new CodexOperationUncertainError('The operation outcome must be reconciled before retrying.');
      }
      if (previous.state === 'completed') return Promise.resolve(previous.result as Result);
      return previous.promise as Promise<Result>;
    }

    const record: StoredOperation = { fingerprint, state: 'pending' };
    this.records.set(operationId, record);
    const promise = this.executeNewOperation(operationId, record, action);
    record.promise = promise;
    return promise;
  }

  async reconcileNotApplied(operationId: string) {
    const record = this.requireUncertain(operationId);
    record.state = 'removing';
    try {
      await this.persistCurrent();
    } catch (error) {
      record.state = 'uncertain';
      throw error;
    }
    this.records.delete(operationId);
    return record.fingerprint;
  }

  async reconcileCompleted<Result>(operationId: string, result: Result) {
    const record = this.requireUncertain(operationId);
    record.state = 'completing';
    record.result = result;
    try {
      await this.persistCurrent();
    } catch (error) {
      record.state = 'uncertain';
      delete record.result;
      throw error;
    }
    record.state = 'completed';
  }

  snapshot(): CodexOperationSnapshot {
    return [...this.records.entries()].flatMap(([operationId, record]) => (
      record.state === 'removing'
        ? []
        : [{
            fingerprint: record.fingerprint,
            operationId,
            result: record.state === 'completed' || record.state === 'completing'
              ? record.result
              : undefined,
            state: record.state === 'completed' || record.state === 'completing'
              ? 'completed' as const
              : 'uncertain' as const
          }]
    ));
  }

  private async executeNewOperation<Result>(
    operationId: string,
    record: StoredOperation,
    action: () => Promise<Result>
  ) {
    try {
      await this.persistCurrent();
    } catch (error) {
      this.records.delete(operationId);
      throw error;
    }

    let result: Result;
    try {
      result = await action();
    } catch (error) {
      delete record.promise;
      if (error instanceof CodexOperationUncertainError) {
        record.state = 'uncertain';
        await this.persistCurrent().catch(() => undefined);
      } else {
        this.records.delete(operationId);
        await this.persistCurrent().catch(() => undefined);
      }
      throw error;
    }

    record.result = result;
    record.state = 'completing';
    try {
      await this.persistCurrent();
    } catch {
      record.state = 'uncertain';
      delete record.promise;
      delete record.result;
      throw new CodexOperationUncertainError(
        'The operation completed, but its durable result could not be confirmed.'
      );
    }
    record.state = 'completed';
    delete record.promise;
    return result;
  }

  private requireUncertain(operationId: string) {
    validateIdentifier(operationId, 'operationId');
    const record = this.records.get(operationId);
    if (record?.state !== 'uncertain') {
      throw new CodexOperationConflictError('Only an uncertain operation can be reconciled.');
    }
    return record;
  }

  private persistCurrent() {
    const write = this.persistenceTail.then(() => this.persist(this.snapshot()));
    this.persistenceTail = write.catch(() => undefined);
    return write;
  }
}
