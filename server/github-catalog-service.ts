import type { GitHubCatalogResult } from '../src/shared/project-space-api';
import type { GitHubCatalogCacheSnapshot, GitHubCatalogCacheStore } from './github-catalog-cache-store';

export interface CatalogRefreshResult {
  catalog: GitHubCatalogResult;
  etag?: string;
  notModified?: boolean;
  timings?: Partial<NonNullable<GitHubCatalogResult['timings']>>;
}

interface GitHubCatalogServiceOptions {
  freshForMs?: number;
  now?: () => number;
  refresh: (etag?: string) => Promise<CatalogRefreshResult>;
  scope?: string;
  store: GitHubCatalogCacheStore;
  userId: string;
}

const refreshes = new Map<string, Promise<GitHubCatalogResult>>();
export const githubCatalogFreshForMs = 60_000;

export class GitHubCatalogService {
  private readonly freshForMs: number;
  private readonly now: () => number;
  private readonly scope: string;
  private readonly failureBackoffMs = 60_000;

  constructor(private readonly options: GitHubCatalogServiceOptions) {
    this.freshForMs = options.freshForMs ?? githubCatalogFreshForMs;
    this.now = options.now ?? Date.now;
    this.scope = options.scope ?? 'default';
  }

  private decorate(snapshot: GitHubCatalogCacheSnapshot, state: 'fresh' | 'stale' | 'refreshing' | 'refresh-failed', message?: string) {
    return {
      ...snapshot.catalog,
      cache: { lastUpdated: snapshot.updatedAt, state },
      ...(message ? { message } : {})
    } satisfies GitHubCatalogResult;
  }

  private async refresh(snapshot: GitHubCatalogCacheSnapshot | null) {
    const key = `${this.options.userId}\0${this.scope}`;
    const existing = refreshes.get(key);
    if (existing) return existing;
    const operation: Promise<GitHubCatalogResult> = (async (): Promise<GitHubCatalogResult> => {
      const attemptedAt = new Date(this.now()).toISOString();
      try {
        if (snapshot) await this.options.store.markRefreshing(this.options.userId, this.scope, attemptedAt);
        const result = await this.options.refresh(snapshot?.etag);
        if (result.notModified && snapshot) {
          const updatedAt = new Date(this.now()).toISOString();
          const next = { ...snapshot, updatedAt };
          await this.options.store.write(next);
          return this.decorate(next, 'fresh');
        }
        if (result.catalog.status !== 'connected') {
          if (snapshot) return this.decorate(snapshot, 'refresh-failed', result.catalog.message);
          return { ...result.catalog, cache: { state: 'miss' as const }, timings: result.timings };
        }
        const updatedAt = new Date(this.now()).toISOString();
        const next = { catalog: result.catalog, etag: result.etag, scope: this.scope, updatedAt, userId: this.options.userId };
        try {
          await this.options.store.write(next);
          return { ...this.decorate(next, 'fresh'), timings: result.timings };
        } catch {
          return { ...result.catalog, cache: { state: 'miss' }, message: 'Catalog loaded, but its cache could not be updated.', timings: result.timings };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'GitHub refresh failed.';
        if (snapshot) {
          await this.options.store.markFailed(this.options.userId, this.scope, message, attemptedAt).catch(() => undefined);
          return this.decorate({ ...snapshot, lastError: message, lastRefreshAt: attemptedAt }, 'refresh-failed', message);
        }
        return { checkedAt: new Date(this.now()).toISOString(), cache: { state: 'miss' as const }, message, repositories: [], status: 'error' };
      } finally {
        refreshes.delete(key);
      }
    })();
    refreshes.set(key, operation);
    return operation;
  }

  async get(forceRefresh = false) {
    const cacheStartedAt = performance.now();
    const snapshot = await this.options.store.read(this.options.userId, this.scope);
    const cacheReadMs = performance.now() - cacheStartedAt;
    if (!snapshot || forceRefresh) return this.refresh(snapshot);
    const age = this.now() - new Date(snapshot.updatedAt).getTime();
    if (age <= this.freshForMs) return { ...this.decorate(snapshot, 'fresh'), timings: { cacheReadMs } };
    const attemptedAge = snapshot.lastRefreshAt ? this.now() - new Date(snapshot.lastRefreshAt).getTime() : Infinity;
    if (snapshot.lastError && attemptedAge < this.failureBackoffMs) {
      return { ...this.decorate(snapshot, 'refresh-failed', snapshot.lastError), timings: { cacheReadMs } };
    }
    void this.refresh(snapshot);
    return { ...this.decorate(snapshot, 'refreshing'), timings: { cacheReadMs } };
  }
}
