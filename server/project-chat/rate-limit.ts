export type ProjectChatRateLimitAction = 'join' | 'send' | 'presence';

export interface ProjectChatRateLimitRule {
  limit: number;
  windowMs: number;
}

export interface ProjectChatRateLimitRequest extends ProjectChatRateLimitRule {
  action: ProjectChatRateLimitAction;
  key: string;
  nowMs: number;
}

export interface ProjectChatRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export interface ProjectChatRateLimiter {
  consume(request: ProjectChatRateLimitRequest): Promise<ProjectChatRateLimitResult>;
}

export const defaultProjectChatRateLimits: Record<
  ProjectChatRateLimitAction,
  ProjectChatRateLimitRule
> = {
  join: { limit: 10, windowMs: 60_000 },
  send: { limit: 120, windowMs: 60_000 },
  presence: { limit: 120, windowMs: 60_000 }
};

interface InMemoryRateLimitBucket {
  events: number[];
  windowMs: number;
}

export class InMemoryProjectChatRateLimiter implements ProjectChatRateLimiter {
  private readonly buckets = new Map<string, InMemoryRateLimitBucket>();
  private readonly maxBuckets: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { maxBuckets?: number } = {}) {
    const maxBuckets = options.maxBuckets ?? 10_000;
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
      throw new Error('maxBuckets must be a positive integer.');
    }
    this.maxBuckets = maxBuckets;
  }

  async consume(request: ProjectChatRateLimitRequest) {
    return this.exclusive(() => {
      const bucketKey = JSON.stringify([request.key, request.action]);
      const cutoff = request.nowMs - request.windowMs;
      const existing = this.buckets.get(bucketKey);
      if (!existing && this.buckets.size >= this.maxBuckets) {
        this.pruneExpired(request.nowMs);
      }
      if (!existing && this.buckets.size >= this.maxBuckets) {
        return { allowed: false, retryAfterMs: request.windowMs };
      }
      const recent = (existing?.events ?? []).filter((time) => time > cutoff);
      if (recent.length >= request.limit) {
        this.buckets.set(bucketKey, { events: recent, windowMs: request.windowMs });
        return {
          allowed: false,
          retryAfterMs: Math.max(1, recent[0] + request.windowMs - request.nowMs)
        };
      }
      recent.push(request.nowMs);
      this.buckets.set(bucketKey, { events: recent, windowMs: request.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    });
  }

  private pruneExpired(nowMs: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.events.length === 0 || bucket.events.at(-1)! + bucket.windowMs <= nowMs) {
        this.buckets.delete(key);
      }
    }
  }

  private async exclusive<T>(operation: () => T | Promise<T>) {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
