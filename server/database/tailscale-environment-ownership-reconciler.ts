import type { DatabaseQueryClient } from './client';

export const tailscaleDeploymentOwner = 'project-space:tailscale-deployment';

const ownershipReconciliationLock =
  'project-space:tailscale-environment-ownership-reconciliation';

/**
 * Serialize every mutation that can change ownership evidence with the
 * reconciliation that consumes that evidence. Call this inside a transaction.
 */
export async function lockTailscaleEnvironmentOwnershipReconciliation(
  client: DatabaseQueryClient
) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [ownershipReconciliationLock]);
}

/**
 * Copy exactly one eligible deployment Environment into its owning account.
 *
 * This is deliberately repeatable. The deployment projection is never
 * changed, ambiguous or stale evidence produces no rows, and a same-UUID
 * user-defined Environment is never overwritten.
 *
 * The caller must hold the transaction-scoped ownership reconciliation lock.
 */
export async function reconcileTailscaleEnvironmentOwnership(
  client: DatabaseQueryClient
) {
  await client.query(
    `with candidate_rows as (
       select distinct
              machine_connector.connector_id,
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
              environment.resource_mode,
              environment.resources
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
           on identity.owner_user_id <> $1
          and identity.revoked_at is null
          and identity.operating_system = case environment.kind
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
         join physical_machines physical_machine
           on physical_machine.owner_user_id = machine_connector.owner_user_id
          and physical_machine.id = machine_connector.physical_machine_id
         join compute_hosts host
           on host.owner_user_id = machine_connector.owner_user_id
          and host.id = machine_connector.physical_machine_id
          and host.identity_resolution = 'resolved'
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
               definition.operating_system_family, definition.bootstrap_strategy,
               definition.ownership) =
              (deployment_definition.slug, deployment_definition.name,
               deployment_definition.kind, deployment_definition.operating_system_family,
               deployment_definition.bootstrap_strategy, deployment_definition.ownership)
          and array(
            select architecture
              from unnest(definition.supported_architectures)
                as supported_architecture(architecture)
             order by architecture
          ) = array(
            select architecture
              from unnest(deployment_definition.supported_architectures)
                as supported_architecture(architecture)
             order by architecture
          )
        where projection.owner_user_id = $1
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
          and count(distinct connector_id) = 1
          and count(distinct host_id) = 1
     )
     insert into compute_environments (
       id, owner_user_id, platform_id, host_id, environment_definition_id,
       identity_version, identity_key, kind, name,
       host_resolution, host_evidence, resource_mode, resources
     )
     select candidate.environment_id, candidate.owner_user_id, candidate.platform_id,
            candidate.host_id, candidate.environment_definition_id, 1,
            candidate.identity_key, candidate.kind, candidate.name,
            'manual', 'user', candidate.resource_mode, candidate.resources
       from candidate_rows candidate
       join unique_candidates unique_candidate
         on unique_candidate.environment_id = candidate.environment_id
     on conflict (id, owner_user_id) do update set
       platform_id = excluded.platform_id,
       host_id = excluded.host_id,
       environment_definition_id = excluded.environment_definition_id,
       identity_resolution = 'resolved',
       identity_key = excluded.identity_key,
       kind = excluded.kind,
       name = excluded.name,
       host_resolution = 'manual',
       host_evidence = 'user',
       resource_mode = excluded.resource_mode,
       resources = excluded.resources,
       updated_at = now()
      where exists (
        select 1
          from compute_environment_definitions current_definition
         where current_definition.owner_user_id = compute_environments.owner_user_id
           and current_definition.id = compute_environments.environment_definition_id
           and current_definition.ownership = 'built_in'
      )
        and (
          compute_environments.platform_id,
          compute_environments.host_id,
          compute_environments.environment_definition_id,
          compute_environments.identity_resolution,
          compute_environments.identity_key,
          compute_environments.kind,
          compute_environments.name,
          compute_environments.host_resolution,
          compute_environments.host_evidence,
          compute_environments.resource_mode,
          compute_environments.resources
        ) is distinct from (
          excluded.platform_id,
          excluded.host_id,
          excluded.environment_definition_id,
          'resolved',
          excluded.identity_key,
          excluded.kind,
          excluded.name,
          'manual',
          'user',
          excluded.resource_mode,
          excluded.resources
      )`,
    [tailscaleDeploymentOwner]
  );
}
