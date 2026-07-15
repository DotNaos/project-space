export const githubIssueCreationMigrationId = '0017_github_issue_creation_operations';

export const githubIssueCreationMigrationSql = `
  create table if not exists github_issue_creation_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    repository_full_name text not null check (btrim(repository_full_name) <> ''),
    operation_id uuid not null,
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (state in ('ambiguous', 'completed', 'pending', 'retryable')),
    issue jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '30 days'),
    primary key (owner_user_id, repository_full_name, operation_id),
    check ((state = 'completed' and issue is not null) or state <> 'completed')
  );

  create index if not exists github_issue_creation_operations_expiry_idx
    on github_issue_creation_operations (expires_at);
`;
