import type { CodexOperationSnapshot } from './contracts';
import { validateIdentifier } from './validation';

type StoredOperation = {
  fingerprint: string;
  promise?: Promise<unknown>;
  result?: unknown;
  state: 'completed' | 'pending' | 'uncertain';
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
      if (previous.state === 'uncertain') {
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
    this.records.delete(operationId);
    try {
      await this.persist(this.snapshot());
    } catch (error) {
      this.records.set(operationId, record);
      throw error;
    }
    return record.fingerprint;
  }

  async reconcileCompleted<Result>(operationId: string, result: Result) {
    const record = this.requireUncertain(operationId);
    record.state = 'completed';
    record.result = result;
    try {
      await this.persist(this.snapshot());
    } catch (error) {
      record.state = 'uncertain';
      delete record.result;
      throw error;
    }
  }

  snapshot(): CodexOperationSnapshot {
    return [...this.records.entries()].map(([operationId, record]) => ({
      fingerprint: record.fingerprint,
      operationId,
      result: record.state === 'completed' ? record.result : undefined,
      state: record.state === 'pending' ? 'uncertain' as const : record.state
    }));
  }

  private async executeNewOperation<Result>(
    operationId: string,
    record: StoredOperation,
    action: () => Promise<Result>
  ) {
    try {
      await this.persist(this.snapshot());
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
        await this.persist(this.snapshot()).catch(() => undefined);
      } else {
        this.records.delete(operationId);
        await this.persist(this.snapshot()).catch(() => undefined);
      }
      throw error;
    }

    record.result = result;
    record.state = 'completed';
    delete record.promise;
    try {
      await this.persist(this.snapshot());
    } catch {
      record.state = 'uncertain';
      delete record.result;
      throw new CodexOperationUncertainError(
        'The operation completed, but its durable result could not be confirmed.'
      );
    }
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
}
