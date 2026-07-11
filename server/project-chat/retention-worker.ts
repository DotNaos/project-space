export interface ProjectChatRetentionTarget {
  purgeExpired(): Promise<number>;
}

export interface ProjectChatIntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ProjectChatRetentionWorkerOptions {
  intervalMs?: number;
  onError?: () => void;
  scheduler?: ProjectChatIntervalScheduler;
}

const defaultScheduler: ProjectChatIntervalScheduler = {
  setInterval(callback, intervalMs) {
    const handle = globalThis.setInterval(callback, intervalMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
    return handle;
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  }
};

export class ProjectChatRetentionWorker {
  private readonly intervalMs: number;
  private readonly onError: () => void;
  private readonly scheduler: ProjectChatIntervalScheduler;
  private readonly target: ProjectChatRetentionTarget;
  private handle: unknown;
  private running: Promise<number> | null = null;

  constructor(target: ProjectChatRetentionTarget, options: ProjectChatRetentionWorkerOptions = {}) {
    this.target = target;
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.onError = options.onError ?? (() => {});
    this.scheduler = options.scheduler ?? defaultScheduler;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Project Chat retention interval must be a positive integer.');
    }
  }

  start() {
    if (this.handle !== undefined) {
      return;
    }
    void this.runScheduled();
    this.handle = this.scheduler.setInterval(() => {
      void this.runScheduled();
    }, this.intervalMs);
  }

  stop() {
    if (this.handle === undefined) {
      return;
    }
    this.scheduler.clearInterval(this.handle);
    this.handle = undefined;
  }

  runOnce() {
    if (!this.running) {
      this.running = this.target.purgeExpired().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runScheduled() {
    try {
      await this.runOnce();
    } catch {
      this.onError();
    }
  }
}
