import type {
  CanonicalRuntimeControlOperationRecord,
  CanonicalRuntimeControlOperationStore
} from './operation-store-contracts';

export class MemoryCanonicalRuntimeControlOperationStore
implements CanonicalRuntimeControlOperationStore {
  private readonly records = new Map<string, CanonicalRuntimeControlOperationRecord>();
  private readonly generationWatermarks = new Map<string, { commandSequence: number; eventSequence: number }>();

  async reserve(input: Parameters<CanonicalRuntimeControlOperationStore['reserve']>[0]) {
    const record = this.records.get(recordKey(input.identity.ownerUserId, input.identity.operationId));
    if (record) {
      if (record.fingerprint !== input.fingerprint ||
          stableJson({ ...record.identity, sessionId: '' }) !==
            stableJson({ ...input.identity, sessionId: '' })) {
        return { kind: 'conflict' as const };
      }
      if (record.state === 'completed' || record.state === 'failed' ||
          record.state === 'blocked_dependency') {
        return { kind: 'replayed' as const, record };
      }
      if (record.identity.sessionId !== input.identity.sessionId) return { kind: 'conflict' as const };
      if (record.state === 'reserved' || record.state === 'dispatching') {
        return { kind: 'in_progress' as const };
      }
      return { kind: 'replayed' as const, record };
    }
    if (input.identity.accessMode === 'mutation' && [...this.records.values()].some((candidate) =>
      candidate.identity.ownerUserId === input.identity.ownerUserId &&
      candidate.identity.workspaceId === input.identity.workspaceId &&
      candidate.identity.generation === input.identity.generation &&
      candidate.identity.accessMode === 'mutation' &&
      ['reserved', 'dispatching', 'uncertain'].includes(candidate.state)
    )) return { kind: 'in_progress' as const };
    const created: CanonicalRuntimeControlOperationRecord = {
      fingerprint: input.fingerprint,
      identity: input.identity,
      state: 'reserved'
    };
    this.records.set(recordKey(input.identity.ownerUserId, input.identity.operationId), created);
    return { kind: 'new' as const, record: created };
  }

  async markDispatchAttempted(input: Parameters<CanonicalRuntimeControlOperationStore['markDispatchAttempted']>[0]) {
    const current = this.exact(input);
    if (current.state !== 'reserved') throw changed();
    const watermark = this.watermark(input.identity.ownerUserId, input.identity.workspaceId, input.identity.generation);
    watermark.commandSequence += 1;
    const updated: CanonicalRuntimeControlOperationRecord = {
      ...current,
      command: { commandId: input.commandId, commandSequence: watermark.commandSequence },
      state: 'dispatching'
    };
    this.save(updated);
    return updated;
  }

  async accept(input: Parameters<CanonicalRuntimeControlOperationStore['accept']>[0]) {
    const current = this.exact(input);
    if (current.acceptedEventSequence !== undefined) return current;
    if (current.state !== 'dispatching' && current.state !== 'uncertain' ||
        input.acceptedCommandSequence !== input.command.commandSequence) {
      throw changed();
    }
    this.advance(input.identity, input.eventSequence);
    const updated = {
      ...current,
      acceptedCommandSequence: input.acceptedCommandSequence,
      acceptedEventSequence: input.eventSequence
    };
    this.save(updated);
    return updated;
  }

  async complete(input: Parameters<CanonicalRuntimeControlOperationStore['complete']>[0]) {
    const current = this.exact(input);
    if (current.state !== 'dispatching') throw changed();
    return this.finish(current, input);
  }

  async reconcile(input: Parameters<CanonicalRuntimeControlOperationStore['reconcile']>[0]) {
    const current = this.exact(input);
    if (current.state !== 'uncertain') throw changed();
    return this.finish(current, input);
  }

  async failReserved(input: Parameters<CanonicalRuntimeControlOperationStore['failReserved']>[0]) {
    const current = this.exact(input);
    if (current.state !== 'reserved') throw changed();
    const updated: CanonicalRuntimeControlOperationRecord = {
      ...current,
      completedAt: input.completedAt,
      failureCode: input.failureCode,
      result: input.result,
      state: 'failed'
    };
    this.save(updated);
    return updated;
  }

  async markUncertain(input: Parameters<CanonicalRuntimeControlOperationStore['markUncertain']>[0]) {
    const current = this.exact(input);
    if (current.state === 'uncertain') {
      if (input.resultEventSequence === undefined) return current;
      if (current.resultEventSequence === input.resultEventSequence) return current;
      if (current.resultEventSequence !== undefined) throw changed();
      this.advance(input.identity, input.resultEventSequence);
      const updated = { ...current, resultEventSequence: input.resultEventSequence };
      this.save(updated);
      return updated;
    }
    if (current.state !== 'dispatching') throw changed();
    if (input.resultEventSequence !== undefined) this.advance(input.identity, input.resultEventSequence);
    const updated: CanonicalRuntimeControlOperationRecord = {
      ...current,
      completedAt: input.completedAt,
      failureCode: 'dispatch_outcome_unknown',
      ...(input.resultEventSequence === undefined ? {} : {
        resultEventSequence: input.resultEventSequence
      }),
      state: 'uncertain'
    };
    this.save(updated);
    return updated;
  }

  async read(ownerUserId: string, operationId: string) {
    return this.records.get(recordKey(ownerUserId, operationId));
  }

  async rebindSession(input: Parameters<CanonicalRuntimeControlOperationStore['rebindSession']>[0]) {
    const current = this.exact(input);
    if (!current.command || current.command.commandId !== input.command.commandId ||
        current.command.commandSequence !== input.command.commandSequence ||
        current.state !== 'dispatching' && current.state !== 'uncertain') throw changed();
    const updated = { ...current, identity: { ...current.identity, sessionId: input.sessionId } };
    this.save(updated);
    return updated;
  }

  async unresolved(ownerUserId: string, workspaceId: string, generation: string) {
    return [...this.records.values()].filter((record) =>
      record.identity.ownerUserId === ownerUserId && record.identity.workspaceId === workspaceId &&
      record.identity.generation === generation &&
      (record.state === 'dispatching' || record.state === 'uncertain')
    ).sort((left, right) => left.command!.commandSequence - right.command!.commandSequence);
  }

  async watermarks(ownerUserId: string, workspaceId: string, generation: string) {
    return { ...this.watermark(ownerUserId, workspaceId, generation) };
  }

  private exact(input: { fingerprint: string; identity: CanonicalRuntimeControlOperationRecord['identity'] }) {
    const current = this.records.get(recordKey(input.identity.ownerUserId, input.identity.operationId));
    if (!current || current.fingerprint !== input.fingerprint ||
        stableJson(current.identity) !== stableJson(input.identity)) throw changed();
    return current;
  }

  private finish(
    current: CanonicalRuntimeControlOperationRecord,
    input: Parameters<CanonicalRuntimeControlOperationStore['complete']>[0]
  ) {
    this.advance(input.identity, input.resultEventSequence);
    const updated: CanonicalRuntimeControlOperationRecord = {
      ...current,
      completedAt: input.completedAt,
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      result: input.result,
      resultEventSequence: input.resultEventSequence,
      state: input.result.state
    };
    this.save(updated);
    return updated;
  }

  private watermark(ownerUserId: string, workspaceId: string, generation: string) {
    const key = `${ownerUserId}\0${workspaceId}\0${generation}`;
    let current = this.generationWatermarks.get(key);
    if (!current) {
      current = { commandSequence: 0, eventSequence: 0 };
      this.generationWatermarks.set(key, current);
    }
    return current;
  }

  private advance(identity: CanonicalRuntimeControlOperationRecord['identity'], eventSequence: number) {
    const watermark = this.watermark(identity.ownerUserId, identity.workspaceId, identity.generation);
    if (eventSequence !== watermark.eventSequence + 1) throw changed();
    watermark.eventSequence = eventSequence;
  }

  private save(record: CanonicalRuntimeControlOperationRecord) {
    this.records.set(recordKey(record.identity.ownerUserId, record.identity.operationId), record);
  }
}

function recordKey(ownerUserId: string, operationId: string) {
  return `${ownerUserId}\0${operationId}`;
}

function changed() {
  return new Error('Canonical Runtime control operation reservation changed.');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
