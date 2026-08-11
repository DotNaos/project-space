import type { ConnectorRuntimeMaintenanceBlocker } from '../connector-runtime-maintenance-safety';
import type { CodexThreadSummary } from './contracts';
import { CodexOperationUncertainError } from './operation-ledger';
import { readLoadedThreads, readThreadResult } from './protocol-readers';
import type { CodexAppServerTransport } from './stdio-transport';

type ReconciliationContext = {
  apply(threads: readonly CodexThreadSummary[]): void;
  getTransport(): Promise<CodexAppServerTransport>;
  isRuntimeEpochCurrent(runtimeEpoch: number): boolean;
  runtimeEpochFor(transport: CodexAppServerTransport): number | undefined;
  signal?: AbortSignal;
};

const maximumConcurrentThreadReads = 8;

export class CodexSessionMaintenanceReconciler {
  private authoritative: boolean;
  private inFlight?: Promise<void>;
  private revision = 0;

  constructor(private readonly required: boolean) {
    this.authoritative = !required;
  }

  maintenanceBlockers(): ConnectorRuntimeMaintenanceBlocker[] {
    return this.required && !this.authoritative
      ? [{ kind: 'codex-runtime', state: 'uncertain' }]
      : [];
  }

  isAuthoritative() {
    return this.authoritative;
  }

  noteLifecycleChange() {
    this.revision += 1;
  }

  markUncertain() {
    if (this.required) this.authoritative = false;
    this.revision += 1;
  }

  reconcile(context: ReconciliationContext) {
    if (!this.required || this.authoritative) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const pending = this.reconcileSnapshot(context).finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    });
    this.inFlight = pending;
    return pending;
  }

  private async reconcileSnapshot(context: ReconciliationContext) {
    try {
      const transport = await context.getTransport();
      const runtimeEpoch = context.runtimeEpochFor(transport);
      if (!runtimeEpoch || !context.isRuntimeEpochCurrent(runtimeEpoch)) throw new Error();
      const revision = this.revision;
      const loaded = readLoadedThreads(await transport.call<unknown>(
        'thread/loaded/list', {}, { signal: context.signal }
      ));
      if (new Set(loaded.data).size !== loaded.data.length) throw new Error();
      const threads = await mapWithConcurrency(
        loaded.data,
        maximumConcurrentThreadReads,
        async (threadId) => {
          const result = readThreadResult(await transport.call<unknown>(
            'thread/read', { includeTurns: true, threadId }, { signal: context.signal }
          ));
          if (result.thread.id !== threadId) throw new Error();
          return result.thread;
        }
      );
      if (revision !== this.revision || !context.isRuntimeEpochCurrent(runtimeEpoch)) {
        throw new Error();
      }
      context.apply(threads);
      this.authoritative = true;
    } catch {
      this.authoritative = false;
      throw new CodexOperationUncertainError(
        'The shared Codex daemon session state could not be reconciled.'
      );
    }
  }
}

async function mapWithConcurrency<Input, Result>(
  input: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Result>
) {
  const results = new Array<Result>(input.length);
  let index = 0;
  const worker = async () => {
    while (index < input.length) {
      const current = index++;
      results[current] = await operation(input[current]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker));
  return results;
}
