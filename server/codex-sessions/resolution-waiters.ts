import type { CodexRpcId } from './contracts';
import { CodexOperationUncertainError } from './operation-ledger';
import { rpcIdKey } from './validation';

type ResolutionWaiter = { reject(error: Error): void; resolve(): void };

export class CodexResolutionWaiters {
  private readonly waiters = new Map<string, ResolutionWaiter>();

  reject(requestId: CodexRpcId, error: Error) {
    const waiter = this.take(requestId);
    waiter?.reject(error);
  }

  rejectAll(error: Error) {
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }

  resolve(requestId: CodexRpcId) {
    const waiter = this.take(requestId);
    waiter?.resolve();
  }

  wait(requestId: CodexRpcId, pending: boolean) {
    if (!pending) return Promise.resolve();
    const key = rpcIdKey(requestId);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(key);
        reject(new CodexOperationUncertainError('The Codex request response was not confirmed.'));
      }, 120_000);
      this.waiters.set(key, {
        reject: (error) => { clearTimeout(timeout); reject(error); },
        resolve: () => { clearTimeout(timeout); resolve(); }
      });
    });
  }

  private take(requestId: CodexRpcId) {
    const key = rpcIdKey(requestId);
    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    return waiter;
  }
}
