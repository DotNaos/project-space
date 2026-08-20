/**
 * Copy a Tailscale-derived Environment into the owning account only when the
 * persisted evidence identifies exactly one connector and physical Host.
 *
 * Tailscale observations are intentionally stored under the deployment scope,
 * while Workspace Runtime authorization is intentionally account-scoped. The
 * copy keeps the original deployment projection intact and gives the account
 * a durable, owner-scoped Environment with the same UUID used by the runtime.
 * Ambiguous names, duplicate Hosts, and user-defined Environment evidence are
 * left untouched so the runtime remains fail-closed.
 */
export const tailscaleEnvironmentOwnershipMigrationId =
  '0059_tailscale_environment_ownership';

export const tailscaleEnvironmentOwnershipMigrationSql = `
  create temporary table project_space_tailscale_environment_candidates (
    environment_id uuid not null,
    owner_user_id text not null,
    platform_id uuid not null,
    host_id uuid not null,
    environment_definition_id uuid not null,
    identity_key text not null,
    kind text not null,
    name text not null,
    resource_mode text not null,
    primary key (environment_id)
  ) on commit drop;

  insert into project_space_tailscale_environment_candidates (
    environment_id, owner_user_id, platform_id, host_id,
    environment_definition_id, identity_key, kind, name, resource_mode
  )
  with candidate_rows as (
    select distinct
           machine_connector.connector_id as connector_id,
           environment.id as environment_id,
           identity.owner_user_id,
           host.platform_id,
           host.id as host_id,
           definition.id as environment_definition_id,
           'account:' || md5(
             'environment:' || identity.owner_user_id || ':tailscale:' || projection.device_id
           ) || md5(
             'tailscale-environment:' || identity.owner_user_id || ':' || projection.device_id
           ) as identity_key,
           environment.kind,
           environment.name,
           environment.resource_mode
      from tailscale_compute_environment_projections projection
      join tailscale_device_classifications classification
        on classification.owner_user_id = projection.owner_user_id
       and classification.device_id = projection.device_id
       and classification.classification = 'environment'
      join tailscale_device_observations observation
        on observation.owner_user_id = projection.owner_user_id
       and observation.device_id = projection.device_id
       and observation.inventory_state = 'current'
       and observation.online
       and observation.fresh_until > now()
      join compute_environments environment
        on environment.owner_user_id = projection.owner_user_id
       and environment.id = projection.environment_id
       and environment.host_resolution = 'unresolved'
      join compute_environment_definitions deployment_definition
        on deployment_definition.owner_user_id = environment.owner_user_id
       and deployment_definition.id = environment.environment_definition_id
       and deployment_definition.ownership = 'built_in'
      join machine_identities identity
        on identity.operating_system = case environment.kind
          when 'native_macos' then 'darwin'
          when 'native_windows' then 'windows'
          when 'native_linux' then 'linux'
          else null
        end
       and regexp_replace(lower(observation.observed_name), '\\.tail[a-z0-9]+\\.ts\\.net$', '') = any(array[
         lower(identity.name), lower(split_part(identity.hostname, '.', 1))
       ])
      join physical_machine_connectors machine_connector
        on machine_connector.owner_user_id = identity.owner_user_id
       and machine_connector.connector_id = identity.id
      join compute_hosts host
        on host.owner_user_id = machine_connector.owner_user_id
       and host.id = machine_connector.physical_machine_id
      join compute_platforms platform
        on platform.owner_user_id = host.owner_user_id
       and platform.id = host.platform_id
       and platform.kind = 'local'
       and platform.name = 'Local & self-hosted'
      join compute_environment_definitions definition
        on definition.owner_user_id = identity.owner_user_id
       and definition.slug = case environment.kind
         when 'native_macos' then 'macos'
         when 'native_windows' then 'windows'
         when 'native_linux' then 'linux'
         else replace(environment.kind, '_', '-')
       end
       and definition.kind = environment.kind
       and definition.ownership = 'built_in'
       and (definition.slug, definition.name, definition.kind,
            definition.operating_system_family, definition.supported_architectures,
            definition.bootstrap_strategy, definition.ownership) =
           (deployment_definition.slug, deployment_definition.name,
            deployment_definition.kind, deployment_definition.operating_system_family,
            deployment_definition.supported_architectures,
            deployment_definition.bootstrap_strategy, deployment_definition.ownership)
     where projection.owner_user_id = 'project-space:tailscale-deployment'
       and not exists (
         select 1
           from compute_environments existing
           join compute_environment_definitions existing_definition
             on existing_definition.owner_user_id = existing.owner_user_id
            and existing_definition.id = existing.environment_definition_id
          where existing.owner_user_id = identity.owner_user_id
            and existing.id = environment.id
            and existing_definition.ownership = 'user_defined'
       )
  ), unique_candidates as (
    select environment_id
      from candidate_rows
     group by environment_id
    having count(*) = 1
  )
  select candidate.environment_id, candidate.owner_user_id, candidate.platform_id,
         candidate.host_id, candidate.environment_definition_id, candidate.identity_key,
         candidate.kind, candidate.name, candidate.resource_mode
    from candidate_rows candidate
    join unique_candidates unique_candidate
      on unique_candidate.environment_id = candidate.environment_id;

  insert into compute_environments (
    id, owner_user_id, platform_id, host_id, environment_definition_id,
    identity_version, identity_key, kind, name,
    host_resolution, host_evidence, resource_mode
  )
  select environment_id, owner_user_id, platform_id, host_id, environment_definition_id,
         1, identity_key, kind, name, 'manual', 'user', resource_mode
    from project_space_tailscale_environment_candidates
  on conflict (id, owner_user_id) do update set
    platform_id = excluded.platform_id,
    host_id = excluded.host_id,
    environment_definition_id = excluded.environment_definition_id,
    identity_key = excluded.identity_key,
    kind = excluded.kind,
    name = excluded.name,
    host_resolution = 'manual',
    host_evidence = 'user',
    resource_mode = excluded.resource_mode,
    updated_at = now()
   where exists (
     select 1
       from compute_environment_definitions current_definition
      where current_definition.owner_user_id = compute_environments.owner_user_id
        and current_definition.id = compute_environments.environment_definition_id
        and current_definition.ownership = 'built_in'
   );
`;
