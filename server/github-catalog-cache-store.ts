import type { GitHubCatalogResult } from '../src/shared/project-space-api';
import type { DatabaseQueryClient } from './database/client';

export const githubCatalogCacheRetentionDays = 90;

export interface GitHubCatalogCacheSnapshot {
  catalog: GitHubCatalogResult;
  etag?: string;
  lastError?: string;
  lastRefreshAt?: string;
  scope: string;
  updatedAt: string;
  userId: string;
}

interface GitHubCatalogCacheRow {
  catalog: unknown;
  etag: string | null;
  last_error: string | null;
  last_refresh_at: Date | string | null;
  scope: string;
  updated_at: Date | string;
  user_id: string;
}

export interface GitHubCatalogCacheStore {
  invalidate(userId: string, scope: string): Promise<void>;
  read(userId: string, scope: string): Promise<GitHubCatalogCacheSnapshot | null>;
  markFailed(userId: string, scope: string, message: string, attemptedAt: string): Promise<void>;
  markRefreshing(userId: string, scope: string, attemptedAt: string): Promise<void>;
  write(snapshot: GitHubCatalogCacheSnapshot): Promise<void>;
}

function isCatalog(value: unknown): value is GitHubCatalogResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GitHubCatalogResult>;
  return typeof candidate.checkedAt === 'string' &&
    Array.isArray(candidate.repositories) &&
    ['connected', 'auth-required', 'not-configured', 'error'].includes(String(candidate.status));
}

export class PostgresGitHubCatalogCacheStore implements GitHubCatalogCacheStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async invalidate(userId: string, scope: string) {
    await this.client.query(
      `delete from github_catalog_cache where user_id = $1 and scope = $2`,
      [userId, scope]
    );
  }

  async read(userId: string, scope: string) {
    const result = await this.client.query<GitHubCatalogCacheRow>(
      `select user_id, scope, catalog, etag, last_error, last_refresh_at, updated_at
         from github_catalog_cache
        where user_id = $1 and scope = $2
          and updated_at >= now() - interval '90 days'`,
      [userId, scope]
    );
    const row = result.rows[0];
    if (!row || !isCatalog(row.catalog) || row.catalog.status !== 'connected') return null;
    return {
      catalog: row.catalog,
      etag: row.etag ?? undefined,
      lastError: row.last_error ?? undefined,
      lastRefreshAt: row.last_refresh_at ? new Date(row.last_refresh_at).toISOString() : undefined,
      scope: row.scope,
      updatedAt: new Date(row.updated_at).toISOString(),
      userId: row.user_id
    };
  }

  async markRefreshing(userId: string, scope: string, attemptedAt: string) {
    await this.client.query(
      `update github_catalog_cache set last_error = null, last_refresh_at = $3::timestamptz
        where user_id = $1 and scope = $2`, [userId, scope, attemptedAt]
    );
  }

  async markFailed(userId: string, scope: string, message: string, attemptedAt: string) {
    await this.client.query(
      `update github_catalog_cache set last_error = $3, last_refresh_at = $4::timestamptz
        where user_id = $1 and scope = $2`, [userId, scope, message.slice(0, 240), attemptedAt]
    );
  }

  async write(snapshot: GitHubCatalogCacheSnapshot) {
    if (snapshot.catalog.status !== 'connected') {
      throw new Error('Only successful GitHub catalogs may be cached.');
    }
    await this.client.query(
      `insert into github_catalog_cache (user_id, scope, catalog, etag, updated_at, last_refresh_at)
       values ($1, $2, $3::jsonb, $4, $5::timestamptz, $5::timestamptz)
       on conflict (user_id, scope) do update
         set catalog = excluded.catalog,
             etag = excluded.etag,
             last_error = null,
             last_refresh_at = excluded.last_refresh_at,
             updated_at = excluded.updated_at`,
      [snapshot.userId, snapshot.scope, JSON.stringify(snapshot.catalog), snapshot.etag ?? null, snapshot.updatedAt]
    );
  }
}
