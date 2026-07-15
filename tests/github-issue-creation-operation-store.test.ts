import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  githubIssueCreationMigrationId,
  githubIssueCreationMigrationSql
} from '../server/database/github-issue-creation-migration';
import { databaseMigrations } from '../server/database/migrations';
import {
  MemoryGitHubIssueCreationOperationStore,
  PostgresGitHubIssueCreationOperationStore,
  type GitHubIssueCreationReservationInput
} from '../server/github-issue-creation-operation-store';
import { gitHubIssueCreationMarker } from '../src/shared/github-issue-creation-marker';
import type { GitHubIssueRecord } from '../src/shared/project-space-api';

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];

  async query<Row>(sql: string, values?: readonly unknown[]) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

const operation: GitHubIssueCreationReservationInput = {
  fingerprint: 'a'.repeat(64),
  operationId: '00000000-0000-4000-8000-000000000187',
  repositoryFullName: 'DotNaos/project-space',
  staleBefore: '2026-07-14T00:00:00.000Z',
  userId: 'user-cata'
};

const issue: GitHubIssueRecord = {
  body: 'Description',
  labels: ['bug'],
  number: 187,
  state: 'open',
  title: 'Create issue modal',
  url: 'https://github.com/DotNaos/project-space/issues/187'
};

describe('GitHub issue creation durable store', () => {
  test('reserves an account and repository scoped operation atomically', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [{ operation_id: operation.operationId }] }
    );
    const store = new PostgresGitHubIssueCreationOperationStore(database);

    expect(await store.reserve(operation)).toEqual({ kind: 'new' });
    expect(database.calls[0]?.sql).toContain('limit 100');
    expect(database.calls[0]?.sql).toContain('order by expires_at');
    expect(database.calls[1]?.sql).toContain('expires_at <= now()');
    expect(database.calls[2]?.sql).toContain('on conflict');
    expect(database.calls[2]?.values).toEqual([
      operation.userId,
      operation.repositoryFullName,
      operation.operationId,
      operation.fingerprint
    ]);
  });

  test('replays only a valid completed issue with the same fingerprint', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{
        expires_at: '2026-08-14T00:00:00.000Z',
        fingerprint_sha256: operation.fingerprint,
        issue: {
          ...issue,
          body: `Description\n\n${gitHubIssueCreationMarker(operation.operationId)}`
        },
        state: 'completed',
        updated_at: '2026-07-14T00:00:01.000Z'
      }] }
    );
    const store = new PostgresGitHubIssueCreationOperationStore(database);
    expect(await store.reserve(operation)).toEqual({ issue, kind: 'replayed' });
  });

  test('turns stale pending work into reconciliation instead of another POST', async () => {
    const database = new FakeDatabase();
    database.responses.push(
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{
        expires_at: '2026-08-14T00:00:00.000Z',
        fingerprint_sha256: operation.fingerprint,
        issue: null,
        state: 'pending',
        updated_at: '2026-07-13T23:59:00.000Z'
      }] },
      { rows: [] }
    );
    const store = new PostgresGitHubIssueCreationOperationStore(database);
    expect(await store.reserve(operation)).toEqual({ kind: 'ambiguous' });
    expect(database.calls.at(-1)?.sql).toContain("set state = 'ambiguous'");
  });

  test('stores completed issue evidence for pending or ambiguous work', async () => {
    const database = new FakeDatabase();
    const store = new PostgresGitHubIssueCreationOperationStore(database);
    await store.complete(operation, issue);

    expect(database.calls[0]?.sql).toContain("state in ('pending', 'ambiguous')");
    expect(database.calls[0]?.values).toContain(JSON.stringify(issue));
  });

  test('removes expired memory records in bounded batches across unrelated operations', async () => {
    let now = 0;
    const store = new MemoryGitHubIssueCreationOperationStore(() => now);
    for (let index = 0; index < 80; index += 1) {
      await store.reserve({
        ...operation,
        operationId: `operation-${index}`
      });
    }

    now = 31 * 24 * 60 * 60 * 1_000;
    await store.reserve({ ...operation, operationId: 'new-operation-one' });
    const records = (store as unknown as { records: Map<string, unknown> }).records;
    expect(records.size).toBe(17);

    await store.reserve({ ...operation, operationId: 'new-operation-two' });
    expect(records.size).toBe(2);
  });
});

describe('GitHub issue creation migration', () => {
  test('reserves migration 0017 after Codex sessions', () => {
    expect(githubIssueCreationMigrationId).toBe('0017_github_issue_creation_operations');
    expect(githubIssueCreationMigrationSql).toContain('github_issue_creation_operations');
    expect(githubIssueCreationMigrationSql).toContain('owner_user_id');
    expect(githubIssueCreationMigrationSql).toContain('repository_full_name');
    expect(databaseMigrations.at(-1)).toEqual({
      id: githubIssueCreationMigrationId,
      sql: githubIssueCreationMigrationSql
    });
  });
});
