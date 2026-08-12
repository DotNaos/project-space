export const hostControlMigrationId = '0047_host_control_operations';

export const hostControlMigrationSql = `
  create table host_control_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'),
    host_id uuid not null,
    actor_type text not null check (actor_type in ('human', 'machine')),
    caller_machine_id text check (caller_machine_id is null or btrim(caller_machine_id) <> ''),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    audit_id uuid,
    state text not null default 'reserved'
      check (state in ('reserved', 'completed', 'failed', 'rejected', 'uncertain')),
    result jsonb,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    primary key (owner_user_id, operation_id),
    foreign key (host_id, owner_user_id)
      references compute_hosts (id, owner_user_id) on delete restrict,
    check ((actor_type = 'machine') = (caller_machine_id is not null)),
    check (result is null or jsonb_typeof(result) = 'object'),
    check (result is null or pg_column_size(result) <= 65536),
    check ((state = 'reserved') = (result is null and audit_id is null and completed_at is null))
  );
`;
