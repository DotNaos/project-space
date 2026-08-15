import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  decryptGitHubOAuthToken,
  encryptGitHubOAuthToken
} from '../server/github-oauth-token-encryption';
import { GitHubOAuthTokenStore } from '../server/github-oauth-token-store';
import type { ProjectSpaceLogger } from '../server/observability';

const databaseUrl = 'postgres://project-space.test/database';
const dedicatedKey = 'dedicated-storage-key-with-32-characters';

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

function logger(): ProjectSpaceLogger {
  const instance: ProjectSpaceLogger = {
    child: () => instance,
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    info: () => undefined,
    warn: () => undefined
  };
  return instance;
}

function queryClient(results: DatabaseQueryResult<unknown>[]) {
  const queries: RecordedQuery[] = [];
  const client: DatabaseQueryClient = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      const result = results.shift() ?? { rows: [] };
      return result as DatabaseQueryResult<Row>;
    }
  };
  return { client, queries };
}

function tokenRow(
  encrypted: ReturnType<typeof encryptGitHubOAuthToken>,
  overrides: Record<string, unknown> = {}
) {
  return {
    created_at: new Date('2026-08-15T10:00:00.000Z'),
    encrypted_access_token: encrypted.encrypted,
    iv: encrypted.iv,
    login: 'octocat',
    scope: 'repo',
    tag: encrypted.tag,
    token_type: 'bearer',
    ...overrides
  };
}

describe('GitHub OAuth token store', () => {
  test('reports a missing connection without attempting a write', async () => {
    const database = queryClient([{ rows: [] }]);
    const store = new GitHubOAuthTokenStore({
      client: database.client,
      databaseUrl,
      environment: { PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey },
      logger: logger()
    });

    expect(await store.read('user-1')).toEqual({ status: 'missing' });
    expect(database.queries).toHaveLength(1);
  });

  test('returns a safe reconnect state when the saved token is unreadable', async () => {
    const encrypted = encryptGitHubOAuthToken('private-github-token', {
      databaseUrl,
      environment: { CLERK_SECRET_KEY: 'old-clerk-key' }
    });
    const database = queryClient([{ rows: [tokenRow(encrypted)] }]);
    const store = new GitHubOAuthTokenStore({
      client: database.client,
      databaseUrl: 'postgres://different/database',
      environment: { CLERK_SECRET_KEY: 'new-clerk-key' },
      logger: logger()
    });

    expect(await store.read('user-1')).toEqual({ status: 'reconnect-required' });
    expect(database.queries).toHaveLength(1);
    expect(JSON.stringify(database.queries)).not.toContain('private-github-token');
  });

  test('migrates a readable legacy token to the dedicated key', async () => {
    const encrypted = encryptGitHubOAuthToken('github-token', {
      databaseUrl,
      environment: { CLERK_SECRET_KEY: 'legacy-clerk-key' }
    });
    const database = queryClient([
      { rows: [tokenRow(encrypted)] },
      { rowCount: 1, rows: [] }
    ]);
    const store = new GitHubOAuthTokenStore({
      client: database.client,
      databaseUrl,
      environment: {
        CLERK_SECRET_KEY: 'legacy-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      },
      logger: logger()
    });

    expect(await store.read('user-1')).toEqual({
      status: 'connected',
      token: {
        accessToken: 'github-token',
        createdAt: '2026-08-15T10:00:00.000Z',
        login: 'octocat',
        scope: 'repo',
        tokenType: 'bearer'
      }
    });
    expect(database.queries).toHaveLength(2);
    expect(database.queries[1]?.sql).toContain('update github_oauth_tokens');

    const values = database.queries[1]?.values ?? [];
    const migrated = {
      encrypted: String(values[1]),
      iv: String(values[2]),
      tag: String(values[3])
    };
    expect(decryptGitHubOAuthToken(migrated, {
      databaseUrl: 'postgres://rotated/database',
      environment: {
        CLERK_SECRET_KEY: 'rotated-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      }
    })).toEqual({ token: 'github-token', usedLegacyKey: false });
  });

  test('writes new tokens with the dedicated key', async () => {
    const database = queryClient([{ rowCount: 1, rows: [] }]);
    const store = new GitHubOAuthTokenStore({
      client: database.client,
      databaseUrl,
      environment: {
        CLERK_SECRET_KEY: 'clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      },
      logger: logger()
    });

    await store.write('user-1', {
      accessToken: 'github-token',
      createdAt: '2026-08-15T10:00:00.000Z',
      login: 'octocat',
      scope: 'repo',
      tokenType: 'bearer'
    });

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.sql).toContain('insert into github_oauth_tokens');
    const values = database.queries[0]?.values ?? [];
    expect(values[0]).toBe('user-1');
    expect(values[1]).toBe('octocat');
    expect(values[5]).toBe('repo');
    expect(values[6]).toBe('bearer');
    expect(decryptGitHubOAuthToken({
      encrypted: String(values[2]),
      iv: String(values[3]),
      tag: String(values[4])
    }, {
      databaseUrl: 'postgres://rotated/database',
      environment: {
        CLERK_SECRET_KEY: 'rotated-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      }
    })).toEqual({ token: 'github-token', usedLegacyKey: false });
  });
});
