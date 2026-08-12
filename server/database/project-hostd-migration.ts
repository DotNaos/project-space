export const projectHostdMigrationId = '0046_project_hostd_telemetry';

export const projectHostdMigrationSql = `
  create table project_hostd_devices (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    device_id uuid not null,
    environment_id uuid not null,
    host_id uuid,
    current_credential_id uuid,
    connection_state text not null default 'stale'
      check (connection_state in ('online', 'stale')),
    health text check (health is null or health in ('healthy', 'degraded')),
    hostd_version text check (
      hostd_version is null or hostd_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$'
    ),
    protocol_version integer check (protocol_version is null or protocol_version = 1),
    last_sequence bigint not null default 0 check (last_sequence >= 0),
    observed_at timestamptz,
    last_seen_at timestamptz,
    uptime_seconds bigint check (uptime_seconds is null or uptime_seconds >= 0),
    partial_metrics text[] not null default '{}' check (
      cardinality(partial_metrics) <= 5 and partial_metrics <@ array[
        'cpu', 'memory', 'storage', 'gpu', 'runtime'
      ]::text[]
    ),
    resources jsonb check (
      resources is null or (
        jsonb_typeof(resources) = 'object' and pg_column_size(resources) <= 65536 and
        resources ?& array['architecture', 'cpu', 'memory', 'operatingSystem', 'storage'] and
        resources - array['architecture', 'cpu', 'gpu', 'memory', 'operatingSystem', 'storage'] = '{}'::jsonb
      )
    ),
    runtimes jsonb not null default '[]'::jsonb check (
      jsonb_typeof(runtimes) = 'array' and jsonb_array_length(runtimes) <= 128 and
      pg_column_size(runtimes) <= 65536
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, device_id),
    unique (owner_user_id, device_id, environment_id, host_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict,
    foreign key (host_id, owner_user_id)
      references compute_hosts (id, owner_user_id) on delete restrict
  );

  create table project_hostd_credentials (
    owner_user_id text not null,
    device_id uuid not null,
    credential_id uuid not null,
    operation_id text not null check (
      operation_id ~ '^[A-Za-z0-9:._-]+$' and char_length(operation_id) <= 256
    ),
    token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null check (
      expires_at >= created_at + interval '1 minute' and
      expires_at <= created_at + interval '90 days'
    ),
    revoked_at timestamptz,
    last_authenticated_at timestamptz,
    primary key (owner_user_id, credential_id),
    unique (owner_user_id, operation_id),
    unique (owner_user_id, device_id, credential_id),
    foreign key (owner_user_id, device_id)
      references project_hostd_devices (owner_user_id, device_id)
      on delete restrict
  );

  alter table project_hostd_devices
    add constraint project_hostd_current_credential_fk
    foreign key (owner_user_id, device_id, current_credential_id)
    references project_hostd_credentials (
      owner_user_id, device_id, credential_id
    ) deferrable initially deferred;

  create table project_hostd_observations (
    owner_user_id text not null,
    device_id uuid not null,
    observation_id text not null check (
      observation_id ~ '^[A-Za-z0-9:._-]+$' and char_length(observation_id) <= 128
    ),
    sequence bigint not null check (sequence > 0),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    safe_payload jsonb not null check (
      jsonb_typeof(safe_payload) = 'object' and pg_column_size(safe_payload) <= 131072 and
      safe_payload - array[
        'deviceId', 'environmentId', 'health', 'hostId', 'hostdVersion', 'observationId',
        'observedAt', 'partialMetrics', 'protocolVersion', 'resources', 'runtimes',
        'schemaVersion', 'sequence', 'type', 'uptimeSeconds'
      ] = '{}'::jsonb
    ),
    observed_at timestamptz not null,
    received_at timestamptz not null default now(),
    retain_until timestamptz not null default now() + interval '24 hours',
    primary key (owner_user_id, device_id, observation_id),
    unique (owner_user_id, device_id, sequence),
    foreign key (owner_user_id, device_id)
      references project_hostd_devices (owner_user_id, device_id) on delete restrict
  );

  create index project_hostd_devices_freshness_idx
    on project_hostd_devices (last_seen_at)
    where connection_state = 'online';
  create index project_hostd_observations_retention_idx
    on project_hostd_observations (retain_until);
`;
