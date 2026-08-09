export const workspaceCommandMigrationId = '0036_workspace_commands';

export const workspaceCommandMigrationSql = `
  alter table runner_workspaces
    add column target_kind text,
    add column target_reference text,
    add constraint runner_workspaces_target_check check (
      (target_kind is null and target_reference is null) or
      (target_kind = 'project_worktree' and target_reference ~ '^wt_[a-f0-9]{24}$')
    );

  create table workspace_commands (
    id uuid not null,
    audit_id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    scope text not null check (scope in ('workspace', 'environment_recovery')),
    execution_id uuid,
    environment_id uuid not null,
    workspace_id uuid,
    connector_id text,
    connector_generation bigint,
    project_id text,
    target_reference text,
    expected_head_sha text,
    workspace_writable boolean,
    repository_writable boolean,
    allow_network boolean,
    provider_kind text,
    provider_resource_id text,
    start_operation_id text not null check (
      start_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    start_operation_fingerprint text not null check (
      start_operation_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    command_sha256 text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
    timeout_seconds integer not null check (timeout_seconds between 1 and 900),
    max_output_bytes integer not null check (max_output_bytes between 1024 and 262144),
    state text not null check (state in (
      'queued', 'running', 'completed', 'failed', 'cancelled', 'uncertain', 'unsupported'
    )),
    stdout text not null default '' check (octet_length(stdout) <= 262144),
    stderr text not null default '' check (octet_length(stderr) <= 262144),
    output_cursor bigint not null default 0 check (output_cursor >= 0),
    truncated boolean not null default false,
    exit_code integer,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (id, owner_user_id),
    unique (audit_id, owner_user_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict,
    foreign key (execution_id, owner_user_id, environment_id)
      references task_executions (id, owner_user_id, environment_id) on delete restrict,
    foreign key (workspace_id, owner_user_id)
      references runner_workspaces (id, owner_user_id) on delete restrict,
    check (
      (scope = 'workspace' and execution_id is not null and workspace_id is not null and
       connector_id is not null and connector_generation > 0 and project_id is not null and
       target_reference ~ '^wt_[a-f0-9]{24}$' and expected_head_sha ~ '^[0-9a-f]{40}$' and
       workspace_writable is not null and repository_writable is not null and
       allow_network is not null and provider_kind is null and
       provider_resource_id is null) or
      (scope = 'environment_recovery' and execution_id is null and workspace_id is null and
       connector_id is null and connector_generation is null and project_id is null and
       target_reference is null and expected_head_sha is null and workspace_writable is null and
       repository_writable is null and allow_network is null and provider_kind = 'github_codespaces' and
       btrim(provider_resource_id) <> '')
    )
  );

  create index workspace_commands_owner_time_idx
    on workspace_commands (owner_user_id, created_at desc, id);
  create index workspace_commands_execution_idx
    on workspace_commands (owner_user_id, execution_id, created_at desc)
    where execution_id is not null;

`;
