export const canonicalRuntimeMutationMigrationId = '0051_canonical_runtime_mutations';

export const canonicalRuntimeMutationMigrationSql = `
  alter table workspace_runtime_credentials
    drop constraint workspace_runtime_requested_capabilities_v2_check;

  alter table workspace_runtime_credentials
    add constraint workspace_runtime_requested_capabilities_v3_check check (
      cardinality(requested_capabilities) <= 3 and
      requested_capabilities <@ array[
        'runtime.codex.v1', 'runtime.control.v1', 'runtime.mutation.v1'
      ]::text[]
    );

  alter table canonical_runtime_control_operations
    drop constraint canonical_runtime_control_operations_operation_check;

  alter table canonical_runtime_control_operations
    add constraint canonical_runtime_control_operations_operation_v2_check check (
      operation in (
        'git.status', 'git.diff', 'worktree.list', 'dev-server.inspect',
        'git.stage', 'git.unstage', 'git.commit', 'task.start',
        'dev-server.start', 'dev-server.publish', 'dev-server.stop'
      )
    ),
    add column safe_input jsonb,
    add column access_mode text not null default 'read';

  update canonical_runtime_control_operations
     set safe_input = case
       when operation = 'git.diff' then
         jsonb_build_object('operation', operation, 'staged', diff_staged)
       else jsonb_build_object('operation', operation)
     end;

  alter table canonical_runtime_control_operations
    alter column safe_input set not null,
    add constraint canonical_runtime_control_operations_safe_input_check check (
      jsonb_typeof(safe_input) = 'object' and pg_column_size(safe_input) <= 65536 and
      safe_input->>'operation' = operation and (
        (operation in ('git.status', 'worktree.list', 'dev-server.inspect') and
          safe_input = jsonb_build_object('operation', operation)) or
        (operation = 'git.diff' and
          safe_input ?& array['operation', 'staged'] and
          safe_input - array['operation', 'staged'] = '{}'::jsonb and
          jsonb_typeof(safe_input->'staged') = 'boolean') or
        (operation in ('git.stage', 'git.unstage') and
          safe_input ?& array['expectedHead', 'operation', 'scope'] and
          safe_input - array['expectedHead', 'operation', 'scope'] = '{}'::jsonb and
          safe_input->>'scope' = 'all' and
          safe_input->>'expectedHead' ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') or
        (operation = 'git.commit' and
          safe_input ?& array['expectedHead', 'message', 'operation'] and
          safe_input - array['expectedHead', 'message', 'operation'] = '{}'::jsonb and
          safe_input->>'expectedHead' ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' and
          safe_input->>'message' <> '' and
          safe_input->>'message' = btrim(safe_input->>'message') and
          safe_input->>'message' !~ '[[:cntrl:]]' and
          octet_length(safe_input->>'message') <= 256) or
        (operation = 'task.start' and
          safe_input ?& array['operation', 'taskExecutionId', 'workspaceLeaseId'] and
          safe_input - array['operation', 'taskExecutionId', 'workspaceLeaseId'] = '{}'::jsonb and
          safe_input->>'taskExecutionId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and
          safe_input->>'workspaceLeaseId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') or
        (operation = 'dev-server.start' and
          safe_input ?& array['operation', 'serverId'] and
          safe_input - array['operation', 'serverId'] = '{}'::jsonb and
          safe_input->>'serverId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') or
        (operation in ('dev-server.publish', 'dev-server.stop') and
          safe_input ?& array['expectedServerGeneration', 'operation', 'serverId'] and
          safe_input - array['expectedServerGeneration', 'operation', 'serverId'] = '{}'::jsonb and
          safe_input->>'serverId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' and
          safe_input->>'expectedServerGeneration' ~ '^[A-Za-z0-9:._-]{1,256}$')
      )
    ),
    add constraint canonical_runtime_control_operations_access_mode_check check (
      access_mode in ('read', 'mutation') and
      (access_mode = 'mutation') = (operation in (
        'git.stage', 'git.unstage', 'git.commit', 'task.start',
        'dev-server.start', 'dev-server.publish', 'dev-server.stop'
      ))
    );

  create unique index canonical_runtime_control_one_unresolved_mutation_idx
    on canonical_runtime_control_operations (owner_user_id, workspace_id, generation)
    where access_mode = 'mutation' and state in ('reserved', 'dispatching', 'uncertain');

  alter table canonical_runtime_control_operations
    drop constraint canonical_runtime_control_operations_state_check,
    drop constraint canonical_runtime_control_operations_failure_code_check;

  do $$
  declare
    lifecycle_constraint text;
    lifecycle_constraint_count integer;
  begin
    select min(conname), count(*) into lifecycle_constraint, lifecycle_constraint_count
      from pg_constraint
      where conrelid = 'canonical_runtime_control_operations'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%state = ''reserved''%'
        and pg_get_constraintdef(oid) like '%state = ''uncertain''%';
    if lifecycle_constraint_count <> 1 then
      raise exception 'expected exactly one canonical Runtime control lifecycle constraint';
    end if;
    execute format(
      'alter table canonical_runtime_control_operations drop constraint %I',
      lifecycle_constraint
    );
  end $$;

  alter table canonical_runtime_control_operations
    add constraint canonical_runtime_control_operations_state_v2_check check (
      state in ('reserved', 'dispatching', 'completed', 'failed', 'blocked_dependency', 'uncertain')
    ),
    add constraint canonical_runtime_control_operations_failure_code_v2_check check (
      failure_code is null or failure_code in (
        'authorization_denied', 'blocked_dependency', 'dispatch_outcome_unknown',
        'invalid_request', 'runtime_failed', 'runtime_stopping', 'target_changed',
        'target_unavailable', 'unavailable'
      ) and (failure_code <> 'blocked_dependency' or
        (operation = 'task.start' and state = 'blocked_dependency'))
    ),
    add constraint canonical_runtime_control_operations_lifecycle_v2_check check (
      (state = 'reserved' and not dispatch_attempted and reserved_until is not null and
        dispatch_lease_until is null and failure_code is null and safe_result is null and
        result_event_sequence is null and completed_at is null) or
      (state = 'dispatching' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is not null and failure_code is null and safe_result is null and
        result_event_sequence is null and completed_at is null) or
      (state = 'completed' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and failure_code is null and safe_result is not null and
        result_event_sequence is not null and completed_at is not null) or
      (state = 'blocked_dependency' and operation = 'task.start' and dispatch_attempted and
        reserved_until is null and
        dispatch_lease_until is null and failure_code = 'blocked_dependency' and
        safe_result is not null and result_event_sequence is not null and completed_at is not null) or
      (state = 'failed' and reserved_until is null and dispatch_lease_until is null and
        failure_code is not null and safe_result is not null and completed_at is not null and
        ((dispatch_attempted and command_id is not null and command_sequence is not null) or
         (not dispatch_attempted and command_id is null and command_sequence is null and
          result_event_sequence is null))) or
      (state = 'uncertain' and dispatch_attempted and reserved_until is null and
        dispatch_lease_until is null and failure_code = 'dispatch_outcome_unknown' and
        safe_result is null and completed_at is not null)
    );

  alter table ssh_gateway_operations
    drop constraint ssh_gateway_operations_operation_v2_check,
    drop constraint ssh_gateway_operations_safe_result_v2_check;

  alter table ssh_gateway_operations
    add constraint ssh_gateway_operations_operation_v3_check check (
      operation in (
        'status.v1', 'worktree.prepare.v1', 'workspace-runtime.start.v1',
        'workspace-runtime.inspect.v1', 'workspace-runtime.suspend.v1',
        'workspace-runtime.resume.v1', 'workspace-runtime.stop.v1',
        'workspace-runtime.clean.v1', 'workspace-runtime.reconcile.v1'
      )
    ),
    add constraint ssh_gateway_operations_safe_result_v3_check check (
      safe_result is null or (
        jsonb_typeof(safe_result) = 'object' and
        safe_result ?& array[
          'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
          'targetIdentityRevision', 'type'
        ] and
        safe_result - array[
          'branch', 'checkedAt', 'commit', 'disposition', 'generation', 'manifestDigest',
          'mode', 'operation', 'operationId', 'schemaVersion', 'sourceHead', 'state',
          'targetIdentityRevision', 'type', 'workspaceId'
        ] = '{}'::jsonb and
        safe_result->>'operationId' = operation_id and
        safe_result->>'targetIdentityRevision' = target_identity_revision and
        safe_result->>'operation' = operation and
        safe_result->'schemaVersion' = '1'::jsonb and
        safe_result->>'type' = 'result' and (
          (operation = 'status.v1' and safe_result->>'state' = 'ready' and
            safe_result - array[
              'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
              'targetIdentityRevision', 'type'
            ] = '{}'::jsonb) or
          (operation = 'worktree.prepare.v1' and safe_result->>'state' = 'ready' and
            safe_result ?& array[
              'branch', 'checkedAt', 'commit', 'operation', 'operationId', 'schemaVersion',
              'state', 'targetIdentityRevision', 'type', 'workspaceId'
            ] and
            safe_result - array[
              'branch', 'checkedAt', 'commit', 'operation', 'operationId', 'schemaVersion',
              'state', 'targetIdentityRevision', 'type', 'workspaceId'
            ] = '{}'::jsonb and
            safe_result->>'branch' ~ '^[^[:cntrl:]]{1,256}$' and
            safe_result->>'commit' ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' and
            safe_result->>'workspaceId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') or
          (operation like 'workspace-runtime.%' and safe_result ?& array[
              'manifestDigest', 'mode', 'sourceHead', 'workspaceId'
            ] and safe_result->>'workspaceId' ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and
            safe_result->>'manifestDigest' ~ '^[0-9a-f]{64}$' and
            safe_result->>'sourceHead' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' and
            safe_result->>'mode' in ('process', 'devcontainer') and
            safe_result->>'state' in (
              'starting', 'running', 'suspending', 'suspended', 'resuming',
              'stopping', 'stopped', 'cleaning', 'stale', 'failed'
            ) and
            (not (safe_result ? 'generation') or safe_result->>'generation' ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') and
            (not (safe_result ? 'disposition') or
              safe_result->>'disposition' in ('created', 'reused', 'cleaned')))
        )
      )
    );
`;
