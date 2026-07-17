export const codexMachineTasksMigrationId = '0021_codex_machine_tasks';

export const codexMachineTasksMigrationSql = `
  create table if not exists codex_machine_task_starts (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    association_key text not null check (association_key ~ '^[0-9a-f]{64}$'),
    dispatch_operation_id text not null check (btrim(dispatch_operation_id) <> ''),
    connector_generation bigint not null check (connector_generation > 0),
    physical_machine_id text not null check (btrim(physical_machine_id) <> ''),
    connector_id text not null check (btrim(connector_id) <> ''),
    state text not null check (state in ('pending', 'completed', 'uncertain')),
    result jsonb check (result is null or jsonb_typeof(result) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, association_key),
    foreign key (connector_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade
  );

  create table if not exists codex_machine_task_start_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (btrim(operation_id) <> ''),
    association_key text not null check (association_key ~ '^[0-9a-f]{64}$'),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (owner_user_id, association_key)
      references codex_machine_task_starts (owner_user_id, association_key)
      on delete cascade
  );

  create index codex_machine_task_starts_state_idx
    on codex_machine_task_starts (state, updated_at);

  create table if not exists codex_machine_task_sends (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (btrim(operation_id) <> ''),
    connector_id text not null check (btrim(connector_id) <> ''),
    thread_id text not null check (btrim(thread_id) <> ''),
    connector_generation bigint not null check (connector_generation > 0),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (state in ('pending', 'completed', 'uncertain')),
    result jsonb check (result is null or jsonb_typeof(result) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (connector_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade
  );

  create unique index codex_machine_task_sends_one_unresolved_per_thread
    on codex_machine_task_sends (owner_user_id, connector_id, thread_id)
    where state in ('pending', 'uncertain');
`;
