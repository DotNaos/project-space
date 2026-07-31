import type {
  PreviewHubCapacityCandidate,
  PreviewHubFailureCode,
  PreviewHubLifecycleState,
  PreviewHubRecord,
  PreviewHubStartRequest
} from '../src/shared/pull-request-preview-hub-api';

export const previewLifecycleTransitions: Record<PreviewHubLifecycleState, readonly PreviewHubLifecycleState[]> = {
  building: ['ready', 'failed', 'expired', 'removed'],
  ready: ['starting', 'expired', 'removed', 'failed'],
  starting: ['online', 'ready', 'failed', 'expired'],
  online: ['stopping', 'failed', 'expired'],
  stopping: ['ready', 'online', 'failed', 'removed'],
  failed: ['building', 'ready', 'starting', 'expired', 'removed'],
  expired: ['removed', 'building'],
  removed: ['building']
};

export function canTransitionPreviewLifecycle(
  from: PreviewHubLifecycleState,
  to: PreviewHubLifecycleState
) {
  return previewLifecycleTransitions[from].includes(to);
}

export function transitionPreviewLifecycle(
  record: PreviewHubRecord,
  lifecycle: PreviewHubLifecycleState,
  now = new Date().toISOString()
): PreviewHubRecord {
  if (!canTransitionPreviewLifecycle(record.lifecycle, lifecycle)) {
    throw new PreviewLifecycleError(
      'transition_invalid',
      `Preview ${record.pullRequestNumber} cannot transition from ${record.lifecycle} to ${lifecycle}.`
    );
  }
  return {
    ...record,
    failureCode: lifecycle === 'failed' ? record.failureCode : undefined,
    failureMessage: lifecycle === 'failed' ? record.failureMessage : undefined,
    lifecycle,
    stateChangedAt: now,
    allowedActions: lifecycle === 'online' ? ['open', 'stop'] : lifecycle === 'ready' ? ['start'] : []
  };
}

export class PreviewLifecycleError extends Error {
  constructor(public readonly code: PreviewHubFailureCode, message: string) {
    super(message);
    this.name = 'PreviewLifecycleError';
  }
}

export interface PreviewLifecycleDependencies {
  now?: () => Date;
  isOpenAtHead(input: { pullRequestNumber: number; repositoryFullName: string; requestedHeadSha: string }): Promise<boolean>;
  prepareTarget?(record: PreviewHubRecord): Promise<void>;
  startRuntime?(record: PreviewHubRecord): Promise<{ verifiedRunningHeadSha: string; previewUrl: string }>;
  stopRuntime?(record: PreviewHubRecord): Promise<void>;
  restoreRuntime?(record: PreviewHubRecord): Promise<boolean>;
}

export interface PreviewStoragePolicy {
  budgetBytes: number;
  minimumFreeBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export class PreviewLifecycleController {
  private readonly records = new Map<string, PreviewHubRecord>();
  private globalLock: Promise<void> = Promise.resolve();
  private readonly prLocks = new Map<string, Promise<void>>();
  private revision = 0;

  constructor(
    private readonly maxOnline: number,
    private readonly dependencies: PreviewLifecycleDependencies,
    private storage?: PreviewStoragePolicy
  ) {}

  inventory() {
    const previews = [...this.records.values()].sort((a, b) => a.pullRequestNumber - b.pullRequestNumber);
    return {
      inventoryRevision: String(this.revision),
      onlineCount: previews.filter((preview) => preview.lifecycle === 'online').length,
      previews
    };
  }

  setStoragePolicy(storage: PreviewStoragePolicy | undefined) {
    this.storage = storage;
  }

  async registerReady(record: PreviewHubRecord) {
    return this.withGlobalAndPrLock(record, async () => {
      if (this.storage && (
        this.storage.freeBytes < this.storage.minimumFreeBytes ||
        this.storage.usedBytes > this.storage.budgetBytes
      )) {
        throw new PreviewLifecycleError('storage_blocked', 'Preview storage policy does not allow registration.');
      }
      const current = this.records.get(this.key(record));
      if (current?.lifecycle === 'online') {
        throw new PreviewLifecycleError('operation_failed', 'An online Preview cannot be replaced by background registration.');
      }
      const next = current
        ? transitionPreviewLifecycle(current, 'ready', this.now())
        : { ...record, lifecycle: 'ready' as const, stateChangedAt: this.now(), allowedActions: ['start' as const] };
      this.records.set(this.key(record), next);
      this.revision += 1;
      return next;
    });
  }

  async start(request: PreviewHubStartRequest) {
    const record = this.find(request.repositoryFullName, request.pullRequestNumber);
    if (!record || record.lifecycle === 'removed') return this.failure('not_found', 'Preview was not found.');
    return this.withGlobalAndPrLock(record, async () => {
      const current = this.records.get(this.key(record))!;
      if (current.requestedHeadSha !== request.requestedHeadSha) return this.failure('head_changed', 'The requested Preview head is no longer current.');
      if (!(await this.dependencies.isOpenAtHead(request))) return this.failure('head_changed', 'The pull request is no longer open at the requested exact head.');
      if (current.lifecycle === 'online') return this.failure('operation_failed', 'Preview is already online.');
      if (current.lifecycle !== 'ready' && current.lifecycle !== 'failed') return this.failure('transition_invalid', `Preview is ${current.lifecycle} and cannot start.`);
      let stoppedReplacement: PreviewHubRecord | undefined;
      const online = [...this.records.values()].filter((entry) => entry.lifecycle === 'online');
      if (online.length >= this.maxOnline && request.selectedReplacementPullRequestNumber === undefined) {
        return {
          code: 'capacity_requires_choice' as const,
          inventoryRevision: String(this.revision),
          online: online.map(toCapacityCandidate)
        };
      }
      if (online.length >= this.maxOnline) {
        const selected = this.find(request.selectedReplacementRepositoryFullName ?? request.repositoryFullName, request.selectedReplacementPullRequestNumber!);
        if (!selected || selected.lifecycle !== 'online' ||
            selected.requestedHeadSha !== request.selectedReplacementHeadSha ||
            request.inventoryRevision !== String(this.revision)) {
          return this.failure('capacity_requires_choice', 'Preview capacity changed. Choose an online Preview again.');
        }
        stoppedReplacement = { ...selected };
        await this.stopLocked(selected);
      }
      let starting = transitionPreviewLifecycle(current, 'starting', this.now());
      this.records.set(this.key(current), starting);
      this.revision += 1;
      try {
        await this.dependencies.prepareTarget?.(starting);
        const result = await this.dependencies.startRuntime?.(starting);
        if (!result || result.verifiedRunningHeadSha !== starting.requestedHeadSha) throw new PreviewLifecycleError('unhealthy', 'Preview health did not prove the exact requested head.');
        starting = transitionPreviewLifecycle(starting, 'online', this.now());
        starting = { ...starting, verifiedRunningHeadSha: result.verifiedRunningHeadSha, previewUrl: result.previewUrl, lastVerifiedAt: this.now() };
        this.records.set(this.key(starting), starting);
        this.revision += 1;
        return { code: 'accepted' as const, inventoryRevision: String(this.revision), lifecycle: 'starting' as const, pullRequestNumber: starting.pullRequestNumber, returnTarget: request.returnTarget };
      } catch (error) {
        let restorationMessage = '';
        if (stoppedReplacement) {
          if (await this.dependencies.restoreRuntime?.(stoppedReplacement)) {
            const restored: PreviewHubRecord = { ...stoppedReplacement, lifecycle: 'online', stateChangedAt: this.now(), allowedActions: ['open', 'stop'] };
            this.records.set(this.key(restored), restored);
            restorationMessage = ' The selected previous Preview was restored.';
          } else {
            restorationMessage = ' The selected previous Preview was not restored.';
          }
        }
        const failed = { ...starting, lifecycle: 'failed' as const, failureCode: error instanceof PreviewLifecycleError ? error.code : 'operation_failed' as const, failureMessage: error instanceof Error ? error.message : 'Preview start failed.', stateChangedAt: this.now(), allowedActions: ['start' as const] };
        this.records.set(this.key(failed), failed);
        this.revision += 1;
        return this.failure(failed.failureCode!, `${failed.failureMessage}${restorationMessage}`);
      }
    });
  }

  async stop(request: { repositoryFullName: string; pullRequestNumber: number; requestedHeadSha: string }) {
    const record = this.find(request.repositoryFullName, request.pullRequestNumber);
    if (!record) return this.failure('not_found', 'Preview was not found.');
    return this.withGlobalAndPrLock(record, async () => {
      const current = this.records.get(this.key(record))!;
      if (current.requestedHeadSha !== request.requestedHeadSha) return this.failure('head_changed', 'The Preview head changed; refusing to stop stale identity.');
      if (current.lifecycle !== 'online') return this.failure('transition_invalid', `Preview is ${current.lifecycle} and is not online.`);
      const stopping = transitionPreviewLifecycle(current, 'stopping', this.now());
      this.records.set(this.key(current), stopping);
      this.revision += 1;
      try {
        await this.dependencies.stopRuntime?.(stopping);
        const ready = transitionPreviewLifecycle(stopping, 'ready', this.now());
        this.records.set(this.key(ready), ready);
        this.revision += 1;
        return { code: 'accepted' as const, inventoryRevision: String(this.revision), lifecycle: 'stopping' as const, pullRequestNumber: ready.pullRequestNumber };
      } catch (error) {
        const restored = await this.dependencies.restoreRuntime?.(current);
        const next = restored ? { ...current, stateChangedAt: this.now() } : { ...stopping, lifecycle: 'failed' as const, failureCode: 'operation_failed' as const, failureMessage: error instanceof Error ? error.message : 'Preview stop failed.', allowedActions: ['start' as const], stateChangedAt: this.now() };
        this.records.set(this.key(next), next);
        this.revision += 1;
        return this.failure('operation_failed', restored ? 'Preview stop failed; the previous online Preview was restored.' : 'Preview stop failed and restoration was not confirmed.');
      }
    });
  }

  async idleShutdown(now = new Date(), idleMs = 60 * 60 * 1000) {
    const candidates = [...this.records.values()].filter((record) => record.lifecycle === 'online' && record.lastActivityAt && (!record.activeLeaseExpiresAt || Date.parse(record.activeLeaseExpiresAt) <= now.getTime()) && now.getTime() - Date.parse(record.lastActivityAt) >= idleMs);
    for (const record of candidates) await this.stop({ repositoryFullName: record.repositoryFullName, pullRequestNumber: record.pullRequestNumber, requestedHeadSha: record.requestedHeadSha });
    return candidates.map((record) => record.pullRequestNumber);
  }

  private async stopLocked(record: PreviewHubRecord) {
    if (record.lifecycle !== 'online') throw new PreviewLifecycleError('transition_invalid', 'Selected replacement is no longer online.');
    const stopping = transitionPreviewLifecycle(record, 'stopping', this.now());
    this.records.set(this.key(record), stopping);
    await this.dependencies.stopRuntime?.(stopping);
    this.records.set(this.key(record), transitionPreviewLifecycle(stopping, 'ready', this.now()));
    this.revision += 1;
  }

  private async withGlobalAndPrLock<T>(record: PreviewHubRecord, callback: () => Promise<T>): Promise<T> {
    const previousGlobal = this.globalLock;
    let releaseGlobal!: () => void;
    this.globalLock = new Promise<void>((resolve) => { releaseGlobal = resolve; });
    await previousGlobal;
    try {
      const key = this.key(record);
      const previousPr = this.prLocks.get(key) ?? Promise.resolve();
      let releasePr!: () => void;
      const currentPr = new Promise<void>((resolve) => { releasePr = resolve; });
      this.prLocks.set(key, currentPr);
      await previousPr;
      try { return await callback(); } finally { releasePr(); if (this.prLocks.get(key) === currentPr) this.prLocks.delete(key); }
    } finally { releaseGlobal(); }
  }

  private key(record: Pick<PreviewHubRecord, 'repositoryFullName' | 'pullRequestNumber'>) { return `${record.repositoryFullName.toLowerCase()}#${record.pullRequestNumber}`; }
  private find(repositoryFullName: string, pullRequestNumber: number) { return this.records.get(`${repositoryFullName.toLowerCase()}#${pullRequestNumber}`); }
  private now() { return (this.dependencies.now ?? (() => new Date()))().toISOString(); }
  private failure(code: PreviewHubFailureCode, message: string) { return { code, message } as const; }
}

function toCapacityCandidate(record: PreviewHubRecord): PreviewHubCapacityCandidate {
  return {
    lastActivityAt: record.lastActivityAt,
    lastVerifiedAt: record.lastVerifiedAt,
    previewUrl: record.previewUrl,
    pullRequestNumber: record.pullRequestNumber,
    repositoryFullName: record.repositoryFullName,
    requestedHeadSha: record.requestedHeadSha
  };
}
