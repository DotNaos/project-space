export const environmentDefinitionReconciliationMigrationId =
  '0058_environment_definition_reconciliation';

/**
 * Repair legacy same-scope duplicates without ever merging a user-defined
 * catalog entry. The inventory presentation layer also reconciles equivalent
 * built-ins across visible owner scopes; this migration repairs durable rows
 * where an older schema allowed duplicate built-ins in one scope.
 */
export const environmentDefinitionReconciliationMigrationSql = `
  do $$
  declare
    duplicate record;
    canonical record;
  begin
    for duplicate in
      select owner_user_id, slug, min(id::text)::uuid as canonical_id
        from compute_environment_definitions
       where ownership = 'built_in'
       group by owner_user_id, slug
      having count(*) > 1
    loop
      select * into canonical
        from compute_environment_definitions
       where owner_user_id = duplicate.owner_user_id
         and id = duplicate.canonical_id;

      if exists (
        select 1
          from compute_environment_definitions candidate
         where candidate.owner_user_id = duplicate.owner_user_id
           and candidate.slug = duplicate.slug
           and candidate.ownership = 'built_in'
           and candidate.id <> duplicate.canonical_id
           and (candidate.name, candidate.kind, candidate.operating_system_family,
                candidate.supported_architectures, candidate.bootstrap_strategy,
                candidate.ownership) is distinct from
               (canonical.name, canonical.kind, canonical.operating_system_family,
                canonical.supported_architectures, canonical.bootstrap_strategy,
                canonical.ownership)
      ) then
        raise exception 'Conflicting built-in Environment definitions for owner % and slug %',
          duplicate.owner_user_id, duplicate.slug;
      end if;

      update compute_environments
         set environment_definition_id = duplicate.canonical_id,
             updated_at = now()
       where owner_user_id = duplicate.owner_user_id
         and environment_definition_id in (
           select id
            from compute_environment_definitions
           where owner_user_id = duplicate.owner_user_id
             and slug = duplicate.slug
             and ownership = 'built_in'
             and id <> duplicate.canonical_id
         );

      delete from compute_environment_definitions
       where owner_user_id = duplicate.owner_user_id
         and slug = duplicate.slug
         and ownership = 'built_in'
         and id <> duplicate.canonical_id;
    end loop;
  end
  $$;

  create or replace function project_space_ensure_connector_environment() returns trigger
  language plpgsql as $$
  declare
    platform_id_value uuid;
    definition_id_value uuid;
    environment_id_value uuid;
    environment_kind_value text;
    environment_name_value text;
    definition_slug_value text;
    definition_name_value text;
    operating_system_family_value text;
  begin
    if exists (
      select 1 from legacy_connector_removal_receipts receipt
       where receipt.owner_user_id = new.user_id
         and receipt.connector_id = new.machine_id
    ) then
      return new;
    end if;

    platform_id_value := project_space_uuid_from_text(
      'project-space:platform:local:' || new.user_id
    );
    environment_id_value := project_space_uuid_from_text(
      'project-space:environment:connector:' || new.user_id || ':' || new.machine_id
    );

    select case operating_system
      when 'darwin' then 'native_macos'
      when 'windows' then 'native_windows'
      when 'linux' then 'native_linux'
      else 'other'
    end,
    name
      into environment_kind_value, environment_name_value
      from machine_identities
     where id = new.machine_id and owner_user_id = new.user_id;

    environment_kind_value := coalesce(environment_kind_value, 'other');
    environment_name_value := coalesce(nullif(environment_name_value, ''), new.machine_id);
    definition_slug_value := case environment_kind_value
      when 'native_macos' then 'macos'
      when 'native_windows' then 'windows'
      when 'native_linux' then 'linux'
      else replace(environment_kind_value, '_', '-')
    end;
    definition_name_value := case environment_kind_value
      when 'native_macos' then 'macOS'
      when 'native_windows' then 'Windows'
      when 'native_linux' then 'Linux'
      else 'Other'
    end;
    operating_system_family_value := case environment_kind_value
      when 'native_macos' then 'macos'
      when 'native_windows' then 'windows'
      when 'native_linux' then 'linux'
      else 'other'
    end;

    insert into compute_platforms (id, owner_user_id, kind, name)
    values (platform_id_value, new.user_id, 'local', 'Local & self-hosted')
    on conflict (id, owner_user_id) do nothing;

    insert into compute_environment_definitions (
      id, owner_user_id, slug, name, kind, operating_system_family,
      bootstrap_strategy, ownership
    ) values (
      project_space_uuid_from_text(
        'project-space:environment-definition:' || new.user_id || ':' || environment_kind_value
      ), new.user_id, definition_slug_value, definition_name_value,
      environment_kind_value, operating_system_family_value,
      case when environment_kind_value = 'other' then 'custom' else 'ssh' end,
      'built_in'
    )
    on conflict (owner_user_id, slug) do update set updated_at = now()
      where compute_environment_definitions.ownership = 'built_in'
        and compute_environment_definitions.name = excluded.name
        and compute_environment_definitions.kind = excluded.kind
        and compute_environment_definitions.operating_system_family = excluded.operating_system_family
        and compute_environment_definitions.supported_architectures = excluded.supported_architectures
        and compute_environment_definitions.bootstrap_strategy = excluded.bootstrap_strategy
    returning id into definition_id_value;

    if definition_id_value is null then
      raise exception 'The built-in Environment definition for owner % and slug % is conflicting',
        new.user_id, definition_slug_value;
    end if;

    insert into compute_environments (
      id, owner_user_id, platform_id, environment_definition_id,
      identity_version, identity_key, kind, name,
      host_resolution, host_evidence, resource_mode
    ) values (
      environment_id_value, new.user_id, platform_id_value, definition_id_value, 1,
      'account:' || md5('environment:' || new.user_id || ':' || new.machine_id) ||
        md5('connector:' || new.user_id || ':' || new.machine_id),
      environment_kind_value, environment_name_value, 'unresolved', 'none', 'dedicated'
    )
    on conflict (id, owner_user_id) do nothing;

    insert into connector_compute_environments (
      connector_id, owner_user_id, environment_id, association_source
    ) values (new.machine_id, new.user_id, environment_id_value, 'legacy')
    on conflict (owner_user_id, connector_id) do nothing;

    return new;
  end
  $$;

  create unique index if not exists compute_environment_definitions_built_in_slug_unique
    on compute_environment_definitions (owner_user_id, slug)
    where ownership = 'built_in';
`;
