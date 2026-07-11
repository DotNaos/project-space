import { describe, expect, test } from 'bun:test';
import { InMemoryProjectChatRateLimiter } from '../server/project-chat/rate-limit';

describe('Project Chat in-memory rate limiter', () => {
  test('stays bounded and reclaims expired buckets before admitting a new key', async () => {
    const limiter = new InMemoryProjectChatRateLimiter({ maxBuckets: 1 });
    const first = await limiter.consume({
      action: 'send', key: 'machine-one', limit: 1, nowMs: 0, windowMs: 1_000
    });
    const blocked = await limiter.consume({
      action: 'send', key: 'machine-two', limit: 1, nowMs: 500, windowMs: 1_000
    });
    const afterExpiry = await limiter.consume({
      action: 'send', key: 'machine-two', limit: 1, nowMs: 1_000, windowMs: 1_000
    });

    expect(first.allowed).toBe(true);
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(afterExpiry.allowed).toBe(true);
  });

  test('rejects invalid capacity configuration', () => {
    expect(() => new InMemoryProjectChatRateLimiter({ maxBuckets: 0 })).toThrow();
  });
});
