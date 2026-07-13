import type { CodexOperationSnapshot } from './contracts';
import { validateIdentifier } from './validation';

type StoredOperation = {
  fingerprint: string;
  promise?: Promise<unknown>;
  result?: unknown;
  state: 'completed' | 'pending' | 'uncertain';
};

export class CodexOperationConflictError extends Error {
  readonly code = 'codex_operation_conflict';
}

export class CodexOperationUncertainError extends Error {
  readonly code = 'codex_operation_uncertain';
}

export class CodexOperationLedger {
  private readonly records = new Map<string, StoredOperation>();

  constructor(snapshot: CodexOperationSnapshot = []) {
    for (const entry of snapshot) {
      const operationId = validateIdentifier(entry.operationId, 'operationId');
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
      if (previous.state === 'uncertain') {
        throw new CodexOperationUncertainError('The operation outcome must be reconciled before retrying.');
      }
      if (previous.state === 'completed') return Promise.resolve(previous.result as Result);
      return previous.promise as Promise<Result>;
    }

    const record: StoredOperation = { fingerprint, state: 'pending' };
    const promise = action().then(
      (result) => {
        record.result = result;
        record.state = 'completed';
        delete record.promise;
        return result;
      },
      (error) => {
        if (error instanceof CodexOperationUncertainError) {
          record.state = 'uncertain';
          delete record.promise;
        } else {
          this.records.delete(operationId);
        }
        throw error;
      }
    );
    record.promise = promise;
    this.records.set(operationId, record);
    return promise;
  }

  reconcileNotApplied(operationId: string) {
    const record = this.requireUncertain(operationId);
    this.records.delete(operationId);
    return record.fingerprint;
  }

  reconcileCompleted<Result>(operationId: string, result: Result) {
    const record = this.requireUncertain(operationId);
    record.state = 'completed';
    record.result = result;
  }

  snapshot(): CodexOperationSnapshot {
    return [...this.records.entries()].flatMap(([operationId, record]) =>
      record.state === 'pending'
        ? []
        : [{
            fingerprint: record.fingerprint,
            operationId,
            result: record.state === 'completed' ? record.result : undefined,
            state: record.state
          }]
    );
  }

  private requireUncertain(operationId: string) {
    validateIdentifier(operationId, 'operationId');
    const record = this.records.get(operationId);
    if (record?.state !== 'uncertain') {
      throw new CodexOperationConflictError('Only an uncertain operation can be reconciled.');
    }
    return record;
  }
}
