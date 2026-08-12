export const canonicalRuntimeControlMigrationId = '0050_canonical_runtime_control_operations';

export const canonicalRuntimeControlMigrationSql = `
  do $$
  declare
    requested_constraint text;
    requested_constraint_count integer;
  begin
    select min(conname), count(*) into requested_constraint, requested_constraint_count
      from pg_constraint
      where conrelid = 'workspace_runtime_credentials'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%requested_capabilities%';
    if requested_constraint_count <> 1 then
      raise exception 'expected exactly one Workspace Runtime requested-capability constraint';
    end if;
    execute format(
      'alter table workspace_runtime_credentials drop constraint %I',
      requested_constraint
    );
  end $$;

  alter table workspace_runtime_credentials
    add constraint workspace_runtime_requested_capabilities_v2_check check (
      cardinality(requested_capabilities) <= 2 and
      requested_capabilities <@ array['runtime.codex.v1', 'runtime.control.v1']::text[]
    );

  alter table workspace_runtime_generations
    add column last_control_command_sequence bigint not null default 0
      check (last_control_command_sequence >= 0),
    add column last_control_event_sequence bigint not null default 0
      check (last_control_event_sequence >= 0);

  create table canonical_runtime_control_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (
      operation_id ~ '^[A-Za-z0-9:._-]+$' and char_length(operation_id) <= 256
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    actor_user_id text not null check (
      btrim(actor_user_id) <> '' and char_length(actor_user_id) <= 256
    ),
    actor_id text not null check (btrim(actor_id) <> '' and char_length(actor_id) <= 256),
    actor_kind text not null check (actor_kind in ('agent', 'human', 'orchestrator', 'system')),
    compatibility_alias boolean not null default false,
    operation text not null check (
      operation in ('git.status', 'git.diff', 'worktree.list', 'dev-server.inspect')
    ),
    diff_staged boolean,
    environment_id uuid not null,
    target_identity_revision text not null check (
      target_identity_revision ~ '^[1-9][0-9]*:[A-Za-z0-9:_-]+$' and
      char_length(target_identity_revision) between 10 and 258
    ),
    workspace_id uuid not null,
    generation uuid not null,
    session_id uuid not null,
    command_id text check (
      command_id is null or (
        command_id ~ '^[A-Za-z0-9:._-]+$' and char_length(command_id) <= 256
      )
    ),
    command_sequence bigint check (command_sequence is null or command_sequence > 0),
    accepted_command_sequence bigint check (
      accepted_command_sequence is null or accepted_command_sequence > 0
    ),
    accepted_event_sequence bigint check (
      accepted_event_sequence is null or accepted_event_sequence > 0
    ),
    result_event_sequence bigint check (result_event_sequence is null or result_event_sequence > 0),
    state text not null default 'reserved'
      check (state in ('reserved', 'dispatching', 'completed', 'failed', 'uncertain')),
    dispatch_attempted boolean not null default false,
    failure_code text check (failure_code is null or failure_code in (
      'authorization_denied', 'dispatch_outcome_unknown', 'invalid_request',
      'runtime_failed', 'runtime_stopping', 'target_changed', 'target_unavailable',
      'unavailable'
    )),
    safe_result jsonb,
    reserved_until timestamptz,
    dispatch_lease_until timestamptz,
    accepted_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (owner_user_id, workspace_id, environment_id, generation)
      references workspace_runtime_generations (
        owner_user_id, workspace_id, environment_id, generation
      ) on delete restrict,
    check ((operation = 'git.diff') = (diff_staged is not null)),
    check (
      (not dispatch_attempted and command_id is null and command_sequence is null) or
      (dispatch_attempted and command_id is not null and command_sequence is not null)
    ),
    check (
      (accepted_command_sequence is null and accepted_event_sequence is null and accepted_at is null) or
      (accepted_command_sequence = command_sequence and accepted_event_sequence is not null and
        accepted_at is not null)
    ),
    check (
      accepted_event_sequence is null or result_event_sequence is null or
      result_event_sequence > accepted_event_sequence
    ),
    check (
      (state = 'reserved' and not dispatch_attempted and reserved_until is not null and
        dispatch_lease_until is null and failure_code is null and safe_result is null and
        result_event_sequence is null and completed_at is null) or
      (state = 'dispatching' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is not null and failure_code is null and safe_result is null and
        result_event_sequence is null and completed_at is null) or
      (state = 'completed' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and failure_code is null and safe_result is not null and
        result_event_sequence is not null and completed_at is not null) or
      (state = 'failed' and reserved_until is null and dispatch_lease_until is null and
        failure_code is not null and safe_result is not null and completed_at is not null and
        ((dispatch_attempted and command_id is not null and command_sequence is not null) or
         (not dispatch_attempted and command_id is null and command_sequence is null and
          result_event_sequence is null))) or
      (state = 'uncertain' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and failure_code = 'dispatch_outcome_unknown' and
        safe_result is null and completed_at is not null)
    ),
    check (
      safe_result is null or (
        jsonb_typeof(safe_result) = 'object' and pg_column_size(safe_result) <= 262144 and
        safe_result->'apiVersion' = '1'::jsonb and
        safe_result->>'operationId' = operation_id and
        safe_result->>'operation' = operation and
        safe_result->>'environmentId' = environment_id::text and
        safe_result->>'targetIdentityRevision' = target_identity_revision and
        safe_result->>'workspaceId' = workspace_id::text and
        safe_result->>'generation' = generation::text and
        safe_result->'replayed' = 'false'::jsonb and
        safe_result->>'state' = state
      )
    )
  );

  create unique index canonical_runtime_control_command_id_idx
    on canonical_runtime_control_operations (owner_user_id, command_id)
    where command_id is not null;

  create unique index canonical_runtime_control_command_sequence_idx
    on canonical_runtime_control_operations (
      owner_user_id, workspace_id, generation, command_sequence
    ) where command_sequence is not null;

  create index canonical_runtime_control_reconciliation_idx
    on canonical_runtime_control_operations (dispatch_lease_until)
    where state = 'dispatching';

  revoke all on canonical_runtime_control_operations from public;
`;
