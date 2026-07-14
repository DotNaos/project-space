export const connectorRuntimeMigrationId = '0015_connector_runtime_operations';

export const connectorRuntimeMigrationSql = `
  create table connector_runtime_operations (
    id uuid primary key,
    machine_id text not null check (btrim(machine_id) <> ''),
    requested_by_user_id text not null check (btrim(requested_by_user_id) <> ''),
    operation text not null check (operation in ('update', 'restart')),
    requested_release_id text check (
      requested_release_id is null or
      (btrim(requested_release_id) <> '' and char_length(requested_release_id) <= 128)
    ),
    expected_release_id text check (
      expected_release_id is null or
      (btrim(expected_release_id) <> '' and char_length(expected_release_id) <= 128)
    ),
    expected_build_id text check (
      expected_build_id is null or
      (btrim(expected_build_id) <> '' and char_length(expected_build_id) <= 128)
    ),
    previous_instance_id text check (
      previous_instance_id is null or
      (btrim(previous_instance_id) <> '' and char_length(previous_instance_id) <= 128)
    ),
    previous_fingerprint jsonb check (
      previous_fingerprint is null or jsonb_typeof(previous_fingerprint) = 'object'
    ),
    expected_fingerprint jsonb check (
      expected_fingerprint is null or jsonb_typeof(expected_fingerprint) = 'object'
    ),
    target text not null check (target in ('darwin-arm64', 'linux-x64', 'windows-x64')),
    state text not null check (state in (
      'queued', 'validating', 'staging', 'verified', 'switching',
      'restarting', 'reconnecting', 'health-checking', 'succeeded',
      'rolling-back', 'failed', 'rolled-back', 'recovery-required'
    )),
    last_failure jsonb check (
      last_failure is null or jsonb_typeof(last_failure) = 'object'
    ),
    started_at timestamptz,
    finished_at timestamptz,
    deadline_at timestamptz not null,
    created_at timestamptz not null,
    updated_at timestamptz not null check (updated_at >= created_at),
    check (
      (operation = 'update' and requested_release_id is not null) or
      (operation = 'restart' and requested_release_id is null)
    )
  );

  create unique index connector_runtime_operations_one_active_per_machine
    on connector_runtime_operations (machine_id)
    where state not in ('succeeded', 'failed', 'rolled-back', 'recovery-required');

  create index connector_runtime_operations_machine_history
    on connector_runtime_operations (machine_id, created_at desc);

  create table connector_runtime_audit_events (
    id bigserial primary key,
    action text not null check (action = 'connector-runtime.maintenance-request'),
    machine_id text,
    user_id text not null check (btrim(user_id) <> ''),
    operation text check (operation is null or operation in ('update', 'restart')),
    operation_id uuid,
    outcome text not null check (outcome in ('accepted', 'rejected')),
    reason text check (reason is null or char_length(reason) <= 128),
    release_id text check (release_id is null or char_length(release_id) <= 128),
    created_at timestamptz not null,
    foreign key (operation_id) references connector_runtime_operations (id) on delete set null
  );

  create index connector_runtime_audit_events_machine_time
    on connector_runtime_audit_events (machine_id, created_at desc);
`;
