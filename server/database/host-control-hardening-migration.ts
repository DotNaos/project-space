export const hostControlHardeningMigrationId = '0048_host_control_hardening';

export const hostControlHardeningMigrationSql = `
  alter table host_control_operations rename to host_control_operations_v1_retained;
  alter index host_control_operations_pkey rename to host_control_operations_v1_retained_pkey;

  create table host_control_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'),
    host_id uuid not null,
    actor_kind text not null check (actor_kind in ('human', 'machine')),
    actor_id text not null check (btrim(actor_id) <> '' and length(actor_id) <= 256),
    capability text not null check (capability in (
      'host.power.on', 'host.power.off', 'host.console.key', 'host.console.chord',
      'host.console.text', 'host.console.mouse_move', 'host.console.mouse_click'
    )),
    effective_risk text not null check (effective_risk in (
      'standard', 'boot', 'disk', 'firmware', 'installer', 'recovery', 'secure_boot'
    )),
    approval_id text check (approval_id is null or approval_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'),
    policy_decision_id text not null check (
      policy_decision_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
    ),
    policy_expires_at timestamptz not null,
    provider_id text not null check (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'),
    binding_revision text not null check (binding_revision ~ '^[0-9a-f]{64}$'),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    audit_id uuid not null,
    attempt_id uuid not null,
    state text not null default 'reserved'
      check (state in ('reserved', 'dispatching', 'completed', 'failed', 'rejected', 'uncertain')),
    result_code text check (result_code is null or result_code in (
      'operation_in_progress', 'provider_unavailable', 'stale_frame', 'unauthorized'
    )),
    result_message text check (result_message is null or (
      length(result_message) between 1 and 512 and result_message !~ '[[:cntrl:]]'
    )),
    reserved_until timestamptz not null,
    dispatch_attempted boolean not null default false,
    created_at timestamptz not null,
    completed_at timestamptz,
    primary key (owner_user_id, operation_id),
    foreign key (host_id, owner_user_id)
      references compute_hosts (id, owner_user_id) on delete restrict,
    check ((effective_risk = 'standard') or approval_id is not null),
    check (policy_expires_at > created_at),
    check (
      (state = 'reserved' and not dispatch_attempted and completed_at is null and
        result_code is null and result_message is null) or
      (state = 'dispatching' and dispatch_attempted and completed_at is null and
        result_code is null and result_message is null) or
      (state in ('completed', 'failed', 'rejected', 'uncertain') and completed_at is not null and
        result_message is not null)
    ),
    check (
      state in ('reserved', 'dispatching') or
      (state = 'completed' and result_code is null) or
      (state in ('failed', 'uncertain') and result_code = 'provider_unavailable') or
      (state = 'rejected' and result_code in (
        'operation_in_progress', 'stale_frame', 'unauthorized'
      ))
    ),
    check (state <> 'completed' or dispatch_attempted),
    check (state <> 'uncertain' or dispatch_attempted)
  );

  create unique index host_control_one_dispatch_per_host
    on host_control_operations (owner_user_id, host_id)
    where state = 'dispatching';

  create index host_control_rate_window
    on host_control_operations (owner_user_id, host_id, created_at)
    where capability like 'host.console.%';
`;
