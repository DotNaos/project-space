export const taskExecutionMigrationId = '0034_task_execution_storage';

export const taskExecutionMigrationSql = `
  create table task_handoffs (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 512),
    created_at timestamptz not null,
    archived_at timestamptz,
    primary key (id, owner_user_id),
    unique (id, owner_user_id, task_id)
  );

  create table task_handoff_revisions (
    handoff_id uuid not null,
    owner_user_id text not null,
    revision integer not null check (revision > 0),
    task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 512),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    objective text not null check (btrim(objective) <> '' and char_length(objective) <= 12000),
    context text not null check (char_length(context) <= 60000),
    decisions jsonb not null check (jsonb_typeof(decisions) = 'array'),
    acceptance_criteria jsonb not null check (jsonb_typeof(acceptance_criteria) = 'array'),
    constraints jsonb not null check (jsonb_typeof(constraints) = 'array'),
    requested_mode text not null check (requested_mode in ('plan', 'implement', 'review', 'repair')),
    created_by_kind text not null check (created_by_kind in ('human', 'orchestrator', 'agent')),
    created_by_id text not null check (
      btrim(created_by_id) <> '' and char_length(created_by_id) <= 256
    ),
    created_at timestamptz not null,
    primary key (handoff_id, owner_user_id, revision),
    unique (handoff_id, owner_user_id, revision, task_id),
    foreign key (handoff_id, owner_user_id, task_id)
      references task_handoffs (id, owner_user_id, task_id)
      on delete restrict
  );

  create table task_handoff_artifacts (
    handoff_id uuid not null,
    owner_user_id text not null,
    revision integer not null,
    artifact_id text not null check (
      artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    ),
    media_type text not null check (
      media_type ~ '^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$' and
      char_length(media_type) <= 128
    ),
    digest_sha256 text not null check (digest_sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes bigint not null check (size_bytes between 0 and 104857600),
    storage_kind text not null check (
      storage_kind in ('project_space_blob', 'github_attachment', 'task_artifact')
    ),
    storage_reference text not null check (
      storage_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$'
    ),
    authorization_kind text not null check (
      authorization_kind in ('owner', 'task', 'execution')
    ),
    authorization_reference text check (
      authorization_reference is null or
      authorization_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$'
    ),
    provenance_kind text not null check (
      provenance_kind in ('user_upload', 'orchestrator', 'provider')
    ),
    provenance_reference text check (
      provenance_reference is null or
      provenance_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$'
    ),
    primary key (handoff_id, owner_user_id, revision, artifact_id),
    foreign key (handoff_id, owner_user_id, revision)
      references task_handoff_revisions (handoff_id, owner_user_id, revision)
      on delete restrict,
    check (authorization_kind = 'owner' or authorization_reference is not null),
    check (provenance_kind = 'user_upload' or provenance_reference is not null)
  );

  create table task_executions (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 512),
    handoff_id uuid not null,
    handoff_revision integer not null check (handoff_revision > 0),
    agent_kind text not null check (agent_kind in ('codex')),
    environment_id uuid not null,
    connector_id text,
    connector_generation bigint,
    repository_id text not null check (
      btrim(repository_id) <> '' and char_length(repository_id) <= 512
    ),
    branch text not null check (btrim(branch) <> '' and char_length(branch) <= 256),
    commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
    state text not null check (state in (
      'planned', 'preparing_environment', 'waiting_for_connector',
      'waiting_for_authorization', 'preparing_workspace', 'starting_agent',
      'running', 'waiting_for_approval', 'waiting_for_input', 'verifying',
      'delivering', 'blocked', 'uncertain', 'completed', 'failed', 'cancelled', 'archived'
    )),
    blocked_reason text check (blocked_reason is null or blocked_reason in (
      'environment_not_running', 'connector_required', 'connector_stale',
      'agent_runtime_missing', 'agent_authorization_required', 'approval_required',
      'input_required', 'workspace_failure', 'capacity_unavailable',
      'provider_authorization_required', 'required_check_failed', 'review_required',
      'delivery_unverified'
    )),
    version bigint not null check (version > 0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    archived_at timestamptz,
    primary key (id, owner_user_id),
    unique (id, owner_user_id, agent_kind),
    unique (id, owner_user_id, repository_id, branch),
    unique (id, owner_user_id, environment_id),
    foreign key (handoff_id, owner_user_id, handoff_revision, task_id)
      references task_handoff_revisions (handoff_id, owner_user_id, revision, task_id)
      on delete restrict,
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict,
    check (
      (connector_id is null and connector_generation is null) or
      (connector_id is not null and connector_generation is not null and connector_generation > 0)
    ),
    check ((state = 'blocked') = (blocked_reason is not null)),
    check ((state = 'archived') = (archived_at is not null))
  );

  create index task_executions_task_time_idx
    on task_executions (owner_user_id, task_id, created_at desc);
  create index task_executions_environment_state_idx
    on task_executions (owner_user_id, environment_id, state, updated_at desc);

  create table task_execution_bindings (
    execution_id uuid not null,
    owner_user_id text not null,
    agent_kind text not null check (agent_kind in ('codex')),
    external_id text not null check (
      external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    ),
    turn_id text check (turn_id is null or turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
    version bigint not null check (version > 0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (execution_id, owner_user_id),
    unique (owner_user_id, agent_kind, external_id),
    foreign key (execution_id, owner_user_id, agent_kind)
      references task_executions (id, owner_user_id, agent_kind)
      on delete restrict
  );

  create table runner_workspaces (
    id uuid not null,
    execution_id uuid not null,
    owner_user_id text not null,
    kind text not null check (kind in ('worktree', 'codespace')),
    repository_id text not null check (
      btrim(repository_id) <> '' and char_length(repository_id) <= 512
    ),
    branch text not null check (btrim(branch) <> '' and char_length(branch) <= 256),
    commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
    state text not null check (state in ('missing', 'preparing', 'ready', 'failed', 'uncertain')),
    version bigint not null check (version > 0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (id, owner_user_id),
    unique (execution_id, owner_user_id),
    foreign key (execution_id, owner_user_id, repository_id, branch)
      references task_executions (id, owner_user_id, repository_id, branch)
      on delete restrict
  );

  create table task_execution_events (
    cursor bigint generated always as identity,
    execution_id uuid not null,
    owner_user_id text not null,
    event_type text not null check (event_type in (
      'created', 'state_changed', 'blocked', 'handoff_updated',
      'workspace_bound', 'executor_bound'
    )),
    previous_handoff_id uuid,
    previous_handoff_revision integer,
    handoff_id uuid,
    handoff_revision integer,
    state text check (state is null or state in (
      'planned', 'preparing_environment', 'waiting_for_connector',
      'waiting_for_authorization', 'preparing_workspace', 'starting_agent',
      'running', 'waiting_for_approval', 'waiting_for_input', 'verifying',
      'delivering', 'blocked', 'uncertain', 'completed', 'failed', 'cancelled', 'archived'
    )),
    message text check (message is null or char_length(message) <= 2000),
    actor_kind text check (actor_kind is null or actor_kind in ('human', 'orchestrator', 'agent', 'system')),
    actor_id text check (actor_id is null or (btrim(actor_id) <> '' and char_length(actor_id) <= 256)),
    created_at timestamptz not null,
    primary key (owner_user_id, execution_id, cursor),
    foreign key (execution_id, owner_user_id)
      references task_executions (id, owner_user_id)
      on delete restrict,
    foreign key (previous_handoff_id, owner_user_id, previous_handoff_revision)
      references task_handoff_revisions (handoff_id, owner_user_id, revision)
      on delete restrict,
    foreign key (handoff_id, owner_user_id, handoff_revision)
      references task_handoff_revisions (handoff_id, owner_user_id, revision)
      on delete restrict,
    check ((actor_kind is null) = (actor_id is null)),
    check (
      (event_type = 'handoff_updated') =
      (previous_handoff_id is not null and previous_handoff_revision is not null and
       handoff_id is not null and handoff_revision is not null)
    )
  );

  create index task_execution_events_cursor_idx
    on task_execution_events (owner_user_id, execution_id, cursor);

  create table execution_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (
      operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    execution_id uuid,
    action text not null check (btrim(action) <> '' and char_length(action) <= 80),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (
      state in ('reserved', 'dispatched', 'confirmed', 'completed', 'blocked', 'uncertain')
    ),
    result jsonb check (result is null or jsonb_typeof(result) = 'object'),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    expires_at timestamptz not null,
    primary key (owner_user_id, operation_id),
    foreign key (execution_id, owner_user_id)
      references task_executions (id, owner_user_id)
      on delete restrict,
    check (expires_at > created_at),
    check (state not in ('completed', 'blocked') or result is not null)
  );

  create index execution_operations_expiry_idx on execution_operations (expires_at)
    where state in ('completed', 'blocked');
  create index execution_operations_execution_idx
    on execution_operations (owner_user_id, execution_id, created_at desc)
    where execution_id is not null;

  create table capacity_leases (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    environment_id uuid not null,
    execution_id uuid not null,
    state text not null check (state in ('active', 'released', 'expired')),
    acquired_at timestamptz not null,
    expires_at timestamptz not null,
    released_at timestamptz,
    primary key (id, owner_user_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict,
    foreign key (execution_id, owner_user_id, environment_id)
      references task_executions (id, owner_user_id, environment_id)
      on delete restrict,
    check (expires_at > acquired_at),
    check ((state = 'released') = (released_at is not null))
  );

  create unique index capacity_leases_one_active_per_environment
    on capacity_leases (owner_user_id, environment_id)
    where state = 'active';
  create index capacity_leases_expiry_idx on capacity_leases (expires_at) where state = 'active';
`;
