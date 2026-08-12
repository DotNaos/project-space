export const workspaceRuntimeSessionMigrationId = '0043_workspace_runtime_sessions';

export const workspaceRuntimeSessionMigrationSql = `
  create table workspace_runtime_generations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    workspace_id uuid not null,
    environment_id uuid not null,
    generation uuid not null,
    branch text not null check (btrim(branch) <> '' and char_length(branch) <= 256),
    commit text not null check (commit ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
    manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
    runtime_version text not null check (btrim(runtime_version) <> '' and char_length(runtime_version) <= 64),
    lifecycle_state text not null default 'starting'
      check (lifecycle_state in ('starting', 'running', 'suspended', 'stopping', 'stopped', 'failed')),
    connection_state text not null default 'connecting'
      check (connection_state in ('connecting', 'online', 'disconnected', 'stale', 'stopped', 'superseded')),
    current_session_id uuid,
    current_credential_id uuid,
    last_sequence bigint not null default 0 check (last_sequence >= 0),
    last_event_at timestamptz not null default now(),
    last_heartbeat_at timestamptz not null default now(),
    dev_servers jsonb not null default '[]'::jsonb check (
      jsonb_typeof(dev_servers) = 'array' and jsonb_array_length(dev_servers) <= 32
    ),
    telemetry jsonb,
    log_pointer text check (
      log_pointer is null or (
        log_pointer ~ '^runtime-log:/[A-Za-z0-9._/-]+$' and
        log_pointer not like '%..%' and char_length(log_pointer) <= 512
      )
    ),
    registered_at timestamptz,
    disconnected_at timestamptz,
    stopped_at timestamptz,
    superseded_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, workspace_id, generation),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict
  );

  create unique index workspace_runtime_generations_current_idx
    on workspace_runtime_generations (owner_user_id, workspace_id)
    where superseded_at is null;

  create index workspace_runtime_generations_stale_idx
    on workspace_runtime_generations (last_heartbeat_at)
    where connection_state in ('online', 'disconnected');

  create table workspace_runtime_credentials (
    owner_user_id text not null,
    workspace_id uuid not null,
    environment_id uuid not null,
    generation uuid not null,
    credential_id uuid not null,
    token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
    capabilities text[] not null check (
      cardinality(capabilities) between 1 and 5 and capabilities <@ array[
        'runtime.lifecycle', 'runtime.heartbeat', 'runtime.dev-servers',
        'runtime.telemetry', 'runtime.log-pointers'
      ]::text[]
    ),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null check (expires_at <= created_at + interval '1 hour'),
    revoked_at timestamptz,
    last_authenticated_at timestamptz,
    primary key (owner_user_id, credential_id),
    foreign key (owner_user_id, workspace_id, generation)
      references workspace_runtime_generations (owner_user_id, workspace_id, generation)
      on delete restrict,
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict
  );

  alter table workspace_runtime_generations
    add constraint workspace_runtime_current_credential_fk
    foreign key (owner_user_id, current_credential_id)
    references workspace_runtime_credentials (owner_user_id, credential_id)
    deferrable initially deferred;

  create table workspace_runtime_events (
    owner_user_id text not null,
    workspace_id uuid not null,
    generation uuid not null,
    event_id text not null check (
      event_id ~ '^[A-Za-z0-9:._-]+$' and char_length(event_id) <= 128
    ),
    sequence bigint not null check (sequence > 0),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    event_type text not null check (event_type in (
      'runtime.lifecycle', 'runtime.heartbeat', 'runtime.dev-servers',
      'runtime.telemetry', 'runtime.log-pointer'
    )),
    safe_payload jsonb not null check (
      jsonb_typeof(safe_payload) = 'object' and pg_column_size(safe_payload) <= 65536
    ),
    observed_at timestamptz not null,
    received_at timestamptz not null default now(),
    retain_until timestamptz not null default now() + interval '24 hours',
    primary key (owner_user_id, workspace_id, generation, event_id),
    unique (owner_user_id, workspace_id, generation, sequence),
    foreign key (owner_user_id, workspace_id, generation)
      references workspace_runtime_generations (owner_user_id, workspace_id, generation)
      on delete restrict
  );

  create index workspace_runtime_events_retention_idx
    on workspace_runtime_events (retain_until);
`;
