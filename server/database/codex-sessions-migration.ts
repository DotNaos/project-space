export const codexSessionsMigrationId = '0016_codex_sessions';

export const codexSessionsMigrationSql = `
  create table if not exists codex_session_snapshots (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    machine_id text not null check (btrim(machine_id) <> ''),
    thread_id text not null check (btrim(thread_id) <> ''),
    snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
    archived boolean not null default false,
    loaded_by_project_space boolean not null default false,
    status text not null check (
      status in ('active', 'archived', 'idle', 'missing', 'offline', 'unavailable')
    ),
    last_activity_at timestamptz not null,
    checked_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, machine_id, thread_id),
    foreign key (machine_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade
  );

  create index if not exists codex_session_snapshots_recent_idx
    on codex_session_snapshots (owner_user_id, machine_id, last_activity_at desc);

  create table if not exists codex_session_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    machine_id text not null check (btrim(machine_id) <> ''),
    thread_id text not null check (btrim(thread_id) <> ''),
    operation_id text not null check (btrim(operation_id) <> ''),
    operation text not null check (
      operation in ('approval', 'continue', 'input', 'interrupt', 'resume', 'turn-start')
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (state in ('pending', 'completed', 'ambiguous', 'rejected')),
    result jsonb check (result is null or jsonb_typeof(result) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, machine_id, thread_id, operation_id),
    foreign key (machine_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade
  );

  create index if not exists codex_session_operations_updated_idx
    on codex_session_operations (updated_at);

  create table if not exists codex_session_events (
    sequence bigserial primary key,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    machine_id text not null check (btrim(machine_id) <> ''),
    thread_id text not null check (btrim(thread_id) <> ''),
    event_id text not null check (btrim(event_id) <> ''),
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '24 hours',
    unique (owner_user_id, machine_id, thread_id, event_id),
    foreign key (machine_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade,
    check (expires_at > created_at)
  );

  create index if not exists codex_session_events_thread_sequence_idx
    on codex_session_events (owner_user_id, machine_id, thread_id, sequence);

  create index if not exists codex_session_events_expiry_idx
    on codex_session_events (expires_at);
`;
