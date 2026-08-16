export const legacyConnectorRemovalMigrationId = '0057_legacy_connector_removal_receipts';

// A receipt hides a retired legacy association without deleting its historical records.
export const legacyConnectorRemovalMigrationSql = `
  create table legacy_connector_removal_receipts (
    id uuid primary key,
    owner_user_id text not null check (
      btrim(owner_user_id) <> '' and char_length(owner_user_id) <= 256 and
      owner_user_id !~ '[[:cntrl:]]'
    ),
    actor_id text not null check (
      btrim(actor_id) <> '' and char_length(actor_id) <= 256 and actor_id !~ '[[:cntrl:]]'
    ),
    request_id text not null check (
      request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    connector_id text not null check (
      connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    environment_id uuid not null,
    created_at timestamptz not null default now(),
    unique (owner_user_id, connector_id),
    unique (owner_user_id, request_id, connector_id)
  );

  create index legacy_connector_removal_receipts_environment_idx
    on legacy_connector_removal_receipts (owner_user_id, environment_id);

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
    definition_id_value := project_space_uuid_from_text(
      'project-space:environment-definition:' || new.user_id || ':' || environment_kind_value
    );

    insert into compute_platforms (id, owner_user_id, kind, name)
    values (platform_id_value, new.user_id, 'local', 'Local & self-hosted')
    on conflict (id, owner_user_id) do nothing;

    insert into compute_environment_definitions (
      id, owner_user_id, slug, name, kind, operating_system_family,
      bootstrap_strategy, ownership
    ) values (
      definition_id_value, new.user_id, definition_slug_value, definition_name_value,
      environment_kind_value, operating_system_family_value,
      case when environment_kind_value = 'other' then 'custom' else 'ssh' end,
      'built_in'
    )
    on conflict (owner_user_id, slug) do nothing;

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
`;
