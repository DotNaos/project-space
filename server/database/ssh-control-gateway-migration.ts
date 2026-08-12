export const sshControlGatewayMigrationId = '0041_ssh_control_gateway_operations';

export const sshControlGatewayMigrationSql = `
  alter table access_routes
    add constraint access_routes_gateway_identity_unique
    unique (id, owner_user_id, environment_id, route_kind, target_identity_revision);

  alter table access_routes
    add column credential_purpose text check (
      credential_purpose is null or credential_purpose = 'project_control_gateway_v1'
    ),
    add constraint access_routes_control_gateway_credential_scope check (
      route_kind <> 'ssh_private_network' or
      not (capabilities @> array['project_cli']::text[]) or (
        credential_purpose is not null and
        credential_purpose = 'project_control_gateway_v1' and
        not (capabilities @> array['interactive_shell']::text[])
      )
    );

  create unique index access_routes_ssh_credential_unique
    on access_routes (owner_user_id, credential_reference)
    where route_kind = 'ssh_private_network' and credential_reference is not null;

  create table ssh_gateway_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (
      operation_id ~ '^[A-Za-z0-9:._-]+$' and char_length(operation_id) <= 256
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    actor_kind text not null check (actor_kind in ('human', 'machine')),
    actor_id text not null check (btrim(actor_id) <> '' and char_length(actor_id) <= 256),
    environment_id uuid not null,
    target_identity_revision text not null check (
      target_identity_revision ~ '^[A-Za-z0-9:._-]+$' and
      char_length(target_identity_revision) between 8 and 256
    ),
    route_id uuid not null,
    route_kind text not null default 'ssh_private_network'
      check (route_kind = 'ssh_private_network'),
    gateway_id text not null check (btrim(gateway_id) <> '' and char_length(gateway_id) <= 256),
    capability text not null default 'project_cli' check (capability = 'project_cli'),
    operation text not null check (operation = 'status.v1'),
    state text not null check (
      state in ('reserved', 'dispatching', 'succeeded', 'failed', 'incompatible', 'uncertain')
    ),
    dispatch_attempted boolean not null default false,
    reserved_until timestamptz,
    dispatch_lease_until timestamptz,
    safe_result jsonb,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict,
    foreign key (route_id, owner_user_id, environment_id, route_kind, target_identity_revision)
      references access_routes (
        id, owner_user_id, environment_id, route_kind, target_identity_revision
      ) on delete restrict,
    check (
      (state = 'reserved' and not dispatch_attempted and safe_result is null and
        completed_at is null and reserved_until is not null and dispatch_lease_until is null) or
      (state = 'dispatching' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is not null and safe_result is null and completed_at is null) or
      (state = 'succeeded' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and safe_result is not null and completed_at is not null) or
      (state = 'failed' and reserved_until is null and dispatch_lease_until is null and
        safe_result is null and completed_at is not null) or
      (state = 'incompatible' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and safe_result is null and completed_at is not null) or
      (state = 'uncertain' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and safe_result is null and completed_at is not null)
    ),
    check (
      safe_result is null or (
        jsonb_typeof(safe_result) = 'object' and
        safe_result ?& array[
          'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
          'targetIdentityRevision', 'type'
        ] and
        safe_result - array[
          'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
          'targetIdentityRevision', 'type'
        ] = '{}'::jsonb and
        safe_result->>'operationId' = operation_id and
        safe_result->>'targetIdentityRevision' = target_identity_revision and
        safe_result->>'operation' = operation and
        safe_result->'schemaVersion' = '1'::jsonb and
        safe_result->>'state' = 'ready' and safe_result->>'type' = 'result'
      )
    )
  );

  create unique index ssh_gateway_operations_unresolved_target_idx
    on ssh_gateway_operations (owner_user_id, environment_id)
    where state in ('reserved', 'dispatching', 'uncertain');

  create table ssh_gateway_operation_events (
    id bigserial primary key,
    owner_user_id text not null,
    operation_id text not null,
    event_kind text not null check (
      event_kind in (
        'reserved', 'reservation_expired', 'dispatch_attempted', 'succeeded', 'failed',
        'incompatible', 'uncertain', 'reconciled_succeeded', 'reconciled_failed'
      )
    ),
    occurred_at timestamptz not null default now(),
    foreign key (owner_user_id, operation_id)
      references ssh_gateway_operations (owner_user_id, operation_id) on delete restrict
  );

  create index ssh_gateway_operation_events_audit_idx
    on ssh_gateway_operation_events (owner_user_id, operation_id, id);
`;
