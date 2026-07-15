export interface TopologySourceScheduler {
  run<T>(load: () => Promise<T>): Promise<T>;
}

interface QueuedSourceCall {
  reject(error: Error): void;
  start(): void;
}

export async function withTopologySourceLimit<T>(
  limit: number,
  signal: AbortSignal | undefined,
  load: (scheduler: TopologySourceScheduler) => Promise<T>
): Promise<T> {
  const scheduler = new PhaseSourceScheduler(limit, signal);
  try {
    return await load(scheduler);
  } finally {
    scheduler.dispose();
  }
}

class PhaseSourceScheduler implements TopologySourceScheduler {
  private active = 0;
  private aborted = false;
  private readonly abortListener = () => this.abort();
  private readonly queue: QueuedSourceCall[] = [];

  constructor(
    private readonly limit: number,
    private readonly signal?: AbortSignal
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Command-center source concurrency must be a positive integer.');
    }
    if (signal?.aborted) {
      this.aborted = true;
    } else {
      signal?.addEventListener('abort', this.abortListener, { once: true });
    }
  }

  run<T>(load: () => Promise<T>): Promise<T> {
    if (this.aborted || this.signal?.aborted) {
      return Promise.reject(abortedSourceCall());
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedSourceCall = {
        reject,
        start: () => {
          if (this.aborted || this.signal?.aborted) {
            reject(abortedSourceCall());
            return;
          }
          this.active += 1;
          let pending: Promise<T>;
          try {
            pending = load();
          } catch (error) {
            reject(error);
            this.finish();
            return;
          }
          void pending.then(
            (value) => {
              resolve(value);
              this.finish();
            },
            (error) => {
              reject(error);
              this.finish();
            }
          );
        }
      };
      this.queue.push(queued);
      this.drain();
    });
  }

  dispose() {
    this.signal?.removeEventListener('abort', this.abortListener);
  }

  private abort() {
    this.aborted = true;
    const error = abortedSourceCall();
    for (const queued of this.queue.splice(0)) queued.reject(error);
  }

  private drain() {
    while (!this.aborted && this.active < this.limit) {
      const queued = this.queue.shift();
      if (!queued) return;
      queued.start();
    }
  }

  private finish() {
    this.active -= 1;
    this.drain();
  }
}

function abortedSourceCall() {
  const error = new Error('Command-center source loading was cancelled.');
  error.name = 'AbortError';
  return error;
}
