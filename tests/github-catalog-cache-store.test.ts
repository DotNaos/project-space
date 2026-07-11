import { describe, expect, test } from 'bun:test';
import { PostgresGitHubCatalogCacheStore } from '../server/github-catalog-cache-store';
import type { DatabaseQueryClient } from '../server/database/client';

describe('PostgresGitHubCatalogCacheStore', () => {
  test('queries by both user and scope and rejects unsuccessful snapshots', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client: DatabaseQueryClient = { async query<Row>(sql, values) { calls.push({ sql, values }); return { rows: [] as Row[] }; } };
    const store = new PostgresGitHubCatalogCacheStore(client);
    await store.read('alice', 'default');
    expect(calls[0]?.values).toEqual(['alice', 'default']);
    expect(calls[0]?.sql).toContain('where user_id = $1 and scope = $2');
    await expect(store.write({ catalog: { checkedAt: '', repositories: [], status: 'error' }, scope: 'default', updatedAt: '', userId: 'alice' })).rejects.toThrow('Only successful');
  });
});
