export const workspaceRuntimeControlMigrationId = '0042_workspace_runtime_control';

export const workspaceRuntimeControlMigrationSql = `
  alter table ssh_gateway_operations
    drop constraint ssh_gateway_operations_operation_check;

  alter table ssh_gateway_operations
    add constraint ssh_gateway_operations_operation_v2_check check (operation in (
      'status.v1', 'workspace-runtime.start.v1', 'workspace-runtime.inspect.v1',
      'workspace-runtime.suspend.v1', 'workspace-runtime.resume.v1',
      'workspace-runtime.stop.v1', 'workspace-runtime.clean.v1',
      'workspace-runtime.reconcile.v1'
    ));

  do $$
  declare
    safe_result_constraint text;
    safe_result_constraint_count integer;
  begin
    select min(conname), count(*) into safe_result_constraint, safe_result_constraint_count
      from pg_constraint
      where conrelid = 'ssh_gateway_operations'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%jsonb_typeof(safe_result)%';
    if safe_result_constraint_count <> 1 then
      raise exception 'expected exactly one legacy SSH gateway safe-result constraint';
    end if;
    execute format('alter table ssh_gateway_operations drop constraint %I', safe_result_constraint);
  end $$;

  alter table ssh_gateway_operations
    add constraint ssh_gateway_operations_safe_result_v2_check check (
      safe_result is null or (
        jsonb_typeof(safe_result) = 'object' and
        safe_result ?& array[
          'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
          'targetIdentityRevision', 'type'
        ] and
        safe_result - array[
          'checkedAt', 'disposition', 'generation', 'manifestDigest', 'mode',
          'operation', 'operationId', 'schemaVersion', 'sourceHead', 'state',
          'targetIdentityRevision', 'type', 'workspaceId'
        ] = '{}'::jsonb and
        safe_result->>'operationId' = operation_id and
        safe_result->>'targetIdentityRevision' = target_identity_revision and
        safe_result->>'operation' = operation and
        safe_result->'schemaVersion' = '1'::jsonb and safe_result->>'type' = 'result' and (
          (operation = 'status.v1' and safe_result->>'state' = 'ready' and
            safe_result - array[
              'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
              'targetIdentityRevision', 'type'
            ] = '{}'::jsonb) or
          (operation <> 'status.v1' and safe_result ?& array[
              'manifestDigest', 'mode', 'sourceHead', 'workspaceId'
            ] and safe_result->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and
            safe_result->>'manifestDigest' ~ '^[0-9a-f]{64}$' and
            safe_result->>'sourceHead' ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' and
            safe_result->>'mode' in ('process', 'devcontainer') and
            safe_result->>'state' in (
              'starting', 'running', 'suspending', 'suspended', 'resuming',
              'stopping', 'stopped', 'cleaning', 'stale', 'failed'
            ) and
            (not (safe_result ? 'generation') or
              safe_result->>'generation' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') and
            (not (safe_result ? 'disposition') or
              safe_result->>'disposition' in ('created', 'reused', 'cleaned')))
        )
      )
    );
`;
