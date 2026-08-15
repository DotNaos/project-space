import { describe, expect, test } from 'bun:test';
import { GitHubCatalogService } from '../server/github-catalog-service';
import type { GitHubCatalogCacheSnapshot, GitHubCatalogCacheStore } from '../server/github-catalog-cache-store';
import type { GitHubCatalogResult } from '../src/shared/project-space-api';

const catalog = (name: string): GitHubCatalogResult => ({
  checkedAt: '2026-07-11T00:00:00.000Z',
  repositories: [{ fullName: `private/${name}`, id: 1, isPrivate: true, name, owner: 'private', projectConfig: { projectYaml: false, status: 'missing', templateLock: false }, url: 'https://example.invalid' }],
  status: 'connected'
});

class MemoryStore implements GitHubCatalogCacheStore {
  records = new Map<string, GitHubCatalogCacheSnapshot>();
  invalidate(userId: string, scope: string) { this.records.delete(`${userId}:${scope}`); return Promise.resolve(); }
  read(userId: string, scope: string) { return Promise.resolve(this.records.get(`${userId}:${scope}`) ?? null); }
  write(snapshot: GitHubCatalogCacheSnapshot) { this.records.set(`${snapshot.userId}:${snapshot.scope}`, snapshot); return Promise.resolve(); }
  markRefreshing(userId: string, scope: string, attemptedAt: string) { const current = this.records.get(`${userId}:${scope}`); if (current) this.records.set(`${userId}:${scope}`, { ...current, lastError: undefined, lastRefreshAt: attemptedAt }); return Promise.resolve(); }
  markFailed(userId: string, scope: string, message: string, attemptedAt: string) { const current = this.records.get(`${userId}:${scope}`); if (current) this.records.set(`${userId}:${scope}`, { ...current, lastError: message, lastRefreshAt: attemptedAt }); return Promise.resolve(); }
}

describe('GitHubCatalogService', () => {
  test('cold success waits and persists only a successful catalog', async () => {
    const store = new MemoryStore();
    const service = new GitHubCatalogService({ now: () => 1000, refresh: async () => ({ catalog: catalog('one'), etag: 'v1' }), store, userId: 'a' });
    const result = await service.get();
    expect(result.repositories[0]?.name).toBe('one');
    expect(store.records.get('a:default')?.etag).toBe('v1');
  });

  test('auth or upstream failure on a miss remains an honest error and is not cached', async () => {
    const store = new MemoryStore();
    const service = new GitHubCatalogService({ refresh: async () => ({ catalog: { checkedAt: '', repositories: [], status: 'auth-required' } }), store, userId: 'a' });
    expect((await service.get()).status).toBe('auth-required');
    expect(store.records.size).toBe(0);
  });

  test('authentication failure invalidates stale connected data and exposes reconnect', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), scope: 'default', updatedAt: new Date().toISOString(), userId: 'a' });
    const service = new GitHubCatalogService({
      refresh: async () => ({
        catalog: {
          checkedAt: '',
          message: 'Reconnect GitHub to continue.',
          repositories: [],
          status: 'auth-required'
        }
      }),
      store,
      userId: 'a'
    });
    const result = await service.get(true);
    expect(result.status).toBe('auth-required');
    expect(result.message).toBe('Reconnect GitHub to continue.');
    expect(result.cache?.state).toBe('miss');
    expect(store.records.size).toBe(0);
  });

  test('still exposes reconnect when stale-cache invalidation fails', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), scope: 'default', updatedAt: new Date().toISOString(), userId: 'a' });
    store.invalidate = () => Promise.reject(new Error('database unavailable'));
    const service = new GitHubCatalogService({
      refresh: async () => ({
        catalog: {
          checkedAt: '',
          message: 'Reconnect GitHub to continue.',
          reconnectRequired: true,
          repositories: [],
          status: 'auth-required'
        }
      }),
      store,
      userId: 'a'
    });

    const result = await service.get(true);
    expect(result.status).toBe('auth-required');
    expect(result.reconnectRequired).toBe(true);
    expect(result.cache?.state).toBe('miss');
  });

  test('checks the saved connection before serving a fresh connected cache', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), scope: 'default', updatedAt: new Date().toISOString(), userId: 'a' });
    let refreshCalls = 0;
    const service = new GitHubCatalogService({
      refresh: async () => {
        refreshCalls += 1;
        return { catalog: catalog('fresh') };
      },
      store,
      userId: 'a',
      validateCachedConnection: async () => ({
        checkedAt: new Date().toISOString(),
        message: 'Reconnect GitHub to continue.',
        reconnectRequired: true,
        repositories: [],
        status: 'auth-required'
      })
    });

    const result = await service.get();
    expect(result.status).toBe('auth-required');
    expect(result.reconnectRequired).toBe(true);
    expect(result.cache?.state).toBe('miss');
    expect(store.records.size).toBe(0);
    expect(refreshCalls).toBe(0);
  });

  test('stale cache returns immediately, refreshes in background, and preserves last-known-good on failure', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), scope: 'default', updatedAt: new Date(0).toISOString(), userId: 'a' });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = new GitHubCatalogService({ freshForMs: 1, now: () => 10_000, refresh: async () => { await blocked; throw new Error('Timed out contacting GitHub.'); }, store, userId: 'a' });
    const startedAt = performance.now();
    const result = await service.get();
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(result.cache?.state).toBe('refreshing');
    expect(result.repositories[0]?.name).toBe('saved');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get('a:default')?.catalog.repositories[0]?.name).toBe('saved');
    expect(store.records.get('a:default')?.lastError).toBe('Timed out contacting GitHub.');
    expect((await service.get()).cache?.state).toBe('refresh-failed');
  });

  test('manual refresh bypasses freshness and preserves stale data when refresh fails', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), scope: 'default', updatedAt: new Date().toISOString(), userId: 'a' });
    const service = new GitHubCatalogService({ refresh: async () => { throw new Error('GitHub unavailable.'); }, store, userId: 'a' });
    const result = await service.get(true);
    expect(result.cache?.state).toBe('refresh-failed');
    expect(result.repositories[0]?.name).toBe('saved');
  });

  test('isolates private catalogs by authenticated user id', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('alice'), scope: 'default', updatedAt: new Date().toISOString(), userId: 'alice' });
    const bob = new GitHubCatalogService({ refresh: async () => ({ catalog: catalog('bob') }), store, userId: 'bob' });
    expect((await bob.get()).repositories[0]?.name).toBe('bob');
    expect(store.records.get('alice:default')?.catalog.repositories[0]?.name).toBe('alice');
  });

  test('304 validation advances freshness without replacing repositories', async () => {
    const store = new MemoryStore();
    await store.write({ catalog: catalog('saved'), etag: 'v1', scope: 'default', updatedAt: new Date(0).toISOString(), userId: 'a' });
    const service = new GitHubCatalogService({ now: () => 5000, refresh: async (etag) => ({ catalog: { checkedAt: '', repositories: [], status: 'connected' }, etag, notModified: true }), store, userId: 'a' });
    const result = await service.get(true);
    expect(result.repositories[0]?.name).toBe('saved');
    expect(result.cache?.lastUpdated).toBe(new Date(5000).toISOString());
  });

  test('coalesces concurrent refreshes for one user and scope', async () => {
    const store = new MemoryStore();
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const refresh = async () => { calls += 1; await blocked; return { catalog: catalog('one') }; };
    const first = new GitHubCatalogService({ refresh, store, userId: 'a' }).get();
    const second = new GitHubCatalogService({ refresh, store, userId: 'a' }).get();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    expect((await first).repositories[0]?.name).toBe('one');
    expect((await second).repositories[0]?.name).toBe('one');
  });
});
