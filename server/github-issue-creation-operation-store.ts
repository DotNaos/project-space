import type { GitHubIssueRecord } from '../src/shared/project-space-api';
import type { DatabaseQueryClient } from './database/client';

export interface GitHubIssueCreationOperationKey {
  fingerprint: string;
  operationId: string;
  repositoryFullName: string;
  userId: string;
}

export interface GitHubIssueCreationReservationInput
  extends GitHubIssueCreationOperationKey {
  staleBefore: string;
}

export type GitHubIssueCreationReservation =
  | { kind: 'ambiguous' }
  | { kind: 'conflict' }
  | { kind: 'new' }
  | { kind: 'pending' }
  | { issue: GitHubIssueRecord; kind: 'replayed' };

export interface GitHubIssueCreationOperationStore {
  complete(
    input: GitHubIssueCreationOperationKey,
    issue: GitHubIssueRecord
  ): Promise<void>;
  markAmbiguous(input: GitHubIssueCreationOperationKey): Promise<void>;
  markRetryable(input: GitHubIssueCreationOperationKey): Promise<void>;
  reserve(
    input: GitHubIssueCreationReservationInput
  ): Promise<GitHubIssueCreationReservation>;
}

interface OperationRecord {
  expiresAt: number;
  fingerprint: string;
  issue?: GitHubIssueRecord;
  state: 'ambiguous' | 'completed' | 'pending' | 'retryable';
  updatedAt: number;
}

interface OperationRow {
  expires_at: Date | string;
  fingerprint_sha256: string;
  issue: unknown;
  state: OperationRecord['state'];
  updated_at: Date | string;
}

const retentionMs = 30 * 24 * 60 * 60 * 1_000;

function operationKey(input: Omit<GitHubIssueCreationOperationKey, 'fingerprint'>) {
  return `${input.userId}\u0000${input.repositoryFullName}\u0000${input.operationId}`;
}

function cloneIssue(issue: GitHubIssueRecord): GitHubIssueRecord {
  return { ...issue, labels: [...issue.labels] };
}

export class MemoryGitHubIssueCreationOperationStore
implements GitHubIssueCreationOperationStore {
  private readonly records = new Map<string, OperationRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  async reserve(input: GitHubIssueCreationReservationInput) {
    const key = operationKey(input);
    const now = this.now();
    let record = this.records.get(key);
    if (record && record.expiresAt <= now) {
      this.records.delete(key);
      record = undefined;
    }
    if (!record) {
      this.records.set(key, {
        expiresAt: now + retentionMs,
        fingerprint: input.fingerprint,
        state: 'pending',
        updatedAt: now
      });
      return { kind: 'new' } as const;
    }
    if (record.fingerprint !== input.fingerprint) return { kind: 'conflict' } as const;
    if (record.state === 'completed' && record.issue) {
      return { issue: cloneIssue(record.issue), kind: 'replayed' } as const;
    }
    if (record.state === 'retryable') {
      record.state = 'pending';
      record.updatedAt = now;
      record.expiresAt = now + retentionMs;
      return { kind: 'new' } as const;
    }
    if (record.state === 'ambiguous') return { kind: 'ambiguous' } as const;
    if (record.updatedAt <= Date.parse(input.staleBefore)) {
      record.state = 'ambiguous';
      record.updatedAt = now;
      return { kind: 'ambiguous' } as const;
    }
    return { kind: 'pending' } as const;
  }

  async complete(input: GitHubIssueCreationOperationKey, issue: GitHubIssueRecord) {
    this.transition(input, ['ambiguous', 'pending'], 'completed', issue);
  }

  async markAmbiguous(input: GitHubIssueCreationOperationKey) {
    this.transition(input, ['pending'], 'ambiguous');
  }

  async markRetryable(input: GitHubIssueCreationOperationKey) {
    this.transition(input, ['pending'], 'retryable');
  }

  private transition(
    input: GitHubIssueCreationOperationKey,
    expected: readonly OperationRecord['state'][],
    state: OperationRecord['state'],
    issue?: GitHubIssueRecord
  ) {
    const record = this.records.get(operationKey(input));
    if (!record || record.fingerprint !== input.fingerprint || !expected.includes(record.state)) {
      return;
    }
    const now = this.now();
    record.expiresAt = now + retentionMs;
    record.issue = issue ? cloneIssue(issue) : undefined;
    record.state = state;
    record.updatedAt = now;
  }
}

export class PostgresGitHubIssueCreationOperationStore
implements GitHubIssueCreationOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async reserve(
    input: GitHubIssueCreationReservationInput
  ): Promise<GitHubIssueCreationReservation> {
    const run = async (client: DatabaseQueryClient) => {
      const values = [input.userId, input.repositoryFullName, input.operationId];
      await client.query(
        `delete from github_issue_creation_operations
          where owner_user_id = $1 and repository_full_name = $2 and operation_id = $3::uuid
            and expires_at <= now()`,
        values
      );
      const inserted = await client.query(
        `insert into github_issue_creation_operations (
           owner_user_id, repository_full_name, operation_id, fingerprint_sha256, state
         ) values ($1, $2, $3::uuid, $4, 'pending')
         on conflict (owner_user_id, repository_full_name, operation_id) do nothing
         returning operation_id`,
        [...values, input.fingerprint]
      );
      if (inserted.rows.length > 0) return { kind: 'new' } as const;

      const existing = await client.query<OperationRow>(
        `select fingerprint_sha256, state, issue, updated_at, expires_at
           from github_issue_creation_operations
          where owner_user_id = $1 and repository_full_name = $2 and operation_id = $3::uuid
          for update`,
        values
      );
      const row = existing.rows[0];
      if (!row || row.fingerprint_sha256 !== input.fingerprint) {
        return { kind: 'conflict' } as const;
      }
      if (row.state === 'completed' && isGitHubIssueRecord(row.issue)) {
        return { issue: cloneIssue(row.issue), kind: 'replayed' } as const;
      }
      if (row.state === 'retryable') {
        await client.query(
          `update github_issue_creation_operations
              set state = 'pending', issue = null, updated_at = now(),
                  expires_at = now() + interval '30 days'
            where owner_user_id = $1 and repository_full_name = $2
              and operation_id = $3::uuid and fingerprint_sha256 = $4 and state = 'retryable'`,
          [...values, input.fingerprint]
        );
        return { kind: 'new' } as const;
      }
      if (row.state === 'ambiguous') return { kind: 'ambiguous' } as const;
      const stale = Date.parse(String(row.updated_at)) <= Date.parse(input.staleBefore);
      if (stale || row.state === 'completed') {
        await client.query(
          `update github_issue_creation_operations
              set state = 'ambiguous', issue = null, updated_at = now()
            where owner_user_id = $1 and repository_full_name = $2
              and operation_id = $3::uuid and fingerprint_sha256 = $4`,
          [...values, input.fingerprint]
        );
        return { kind: 'ambiguous' } as const;
      }
      return { kind: 'pending' } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async complete(input: GitHubIssueCreationOperationKey, issue: GitHubIssueRecord) {
    await this.transition(input, 'completed', issue);
  }

  async markAmbiguous(input: GitHubIssueCreationOperationKey) {
    await this.transition(input, 'ambiguous');
  }

  async markRetryable(input: GitHubIssueCreationOperationKey) {
    await this.transition(input, 'retryable');
  }

  private async transition(
    input: GitHubIssueCreationOperationKey,
    state: 'ambiguous' | 'completed' | 'retryable',
    issue?: GitHubIssueRecord
  ) {
    const sourceStates = state === 'completed' ? "('pending', 'ambiguous')" : "('pending')";
    await this.client.query(
      `update github_issue_creation_operations
          set state = $5, issue = $6::jsonb, updated_at = now(),
              expires_at = now() + interval '30 days'
        where owner_user_id = $1 and repository_full_name = $2 and operation_id = $3::uuid
          and fingerprint_sha256 = $4 and state in ${sourceStates}`,
      [
        input.userId,
        input.repositoryFullName,
        input.operationId,
        input.fingerprint,
        state,
        issue ? JSON.stringify(issue) : null
      ]
    );
  }
}

function isGitHubIssueRecord(value: unknown): value is GitHubIssueRecord {
  if (!value || typeof value !== 'object') return false;
  const issue = value as Partial<GitHubIssueRecord>;
  return Number.isSafeInteger(issue.number) && (issue.number ?? 0) > 0
    && typeof issue.title === 'string' && typeof issue.url === 'string'
    && (issue.state === 'open' || issue.state === 'closed')
    && Array.isArray(issue.labels) && issue.labels.every((label) => typeof label === 'string');
}
