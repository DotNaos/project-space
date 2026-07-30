export const machinePowerMigrationId = '0026_machine_power_operations';

export const machinePowerMigrationSql = `
  create table machine_power_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    actor_type text not null check (actor_type in ('human', 'machine')),
    caller_machine_id text check (
      (actor_type = 'human' and caller_machine_id is null)
      or (
        actor_type = 'machine'
        and caller_machine_id is not null
        and btrim(caller_machine_id) <> ''
      )
    ),
    operation_id text not null check (btrim(operation_id) <> ''),
    physical_machine_id uuid not null,
    requested_state text not null check (requested_state in ('on', 'off')),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (
      state in (
        'dispatching', 'accepted', 'confirmed-online', 'confirmed-offline',
        'unsupported', 'failed', 'uncertain', 'expired'
      )
    ),
    dispatch_attempted boolean not null default false,
    result jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (physical_machine_id, owner_user_id)
      references physical_machines (id, owner_user_id)
      on delete cascade
  );

  create unique index machine_power_one_dispatch_per_machine
    on machine_power_operations (owner_user_id, physical_machine_id)
    where state = 'dispatching'
       or (state in ('accepted', 'uncertain') and dispatch_attempted);

  create index machine_power_operations_machine_time
    on machine_power_operations (owner_user_id, physical_machine_id, created_at desc);
`;
