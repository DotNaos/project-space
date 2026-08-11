export const environmentCatalogMigrationId = '0039_environment_catalog';

export const environmentCatalogMigrationSql = `
  create table compute_environment_definitions (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    slug text not null check (
      slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 80
    ),
    name text not null check (btrim(name) <> '' and char_length(name) <= 128),
    kind text not null check (
      kind in (
        'native_macos', 'native_windows', 'native_linux', 'wsl', 'docker', 'devbox',
        'github_codespace', 'cloud_sandbox', 'kubernetes_workload', 'virtual_machine', 'other'
      )
    ),
    operating_system_family text not null check (
      operating_system_family in ('macos', 'windows', 'linux', 'other')
    ),
    supported_architectures text[] not null default '{}',
    bootstrap_strategy text not null check (
      bootstrap_strategy in ('ssh', 'provider_native', 'workspace_runtime', 'custom')
    ),
    ownership text not null check (ownership in ('built_in', 'user_defined')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, slug)
  );

  insert into compute_environment_definitions (
    id, owner_user_id, slug, name, kind, operating_system_family,
    supported_architectures, bootstrap_strategy, ownership
  )
  select
    project_space_uuid_from_text(
      'project-space:environment-definition:' || source.owner_user_id || ':' || source.kind
    ),
    source.owner_user_id,
    case source.kind
      when 'native_macos' then 'macos'
      when 'native_windows' then 'windows'
      when 'native_linux' then 'linux'
      when 'github_codespace' then 'github-codespace'
      when 'cloud_sandbox' then 'cloud-sandbox'
      when 'kubernetes_workload' then 'kubernetes-workload'
      when 'virtual_machine' then 'virtual-machine'
      else replace(source.kind, '_', '-')
    end,
    case source.kind
      when 'native_macos' then 'macOS'
      when 'native_windows' then 'Windows'
      when 'native_linux' then 'Linux'
      when 'wsl' then 'WSL'
      when 'docker' then 'Docker'
      when 'devbox' then 'Devbox'
      when 'github_codespace' then 'GitHub Codespace'
      when 'cloud_sandbox' then 'Cloud sandbox'
      when 'kubernetes_workload' then 'Kubernetes workload'
      when 'virtual_machine' then 'Virtual machine'
      else 'Other'
    end,
    source.kind,
    case source.kind
      when 'native_macos' then 'macos'
      when 'native_windows' then 'windows'
      when 'native_linux' then 'linux'
      when 'wsl' then 'linux'
      when 'github_codespace' then 'linux'
      else 'other'
    end,
    '{}',
    case source.kind
      when 'native_macos' then 'ssh'
      when 'native_windows' then 'ssh'
      when 'native_linux' then 'ssh'
      when 'wsl' then 'ssh'
      when 'virtual_machine' then 'ssh'
      when 'docker' then 'workspace_runtime'
      when 'devbox' then 'workspace_runtime'
      when 'other' then 'custom'
      else 'provider_native'
    end,
    'built_in'
  from (
    select distinct owner_user_id, kind from compute_environments
  ) source
  on conflict (owner_user_id, slug) do nothing;

  alter table compute_environments
    add column environment_definition_id uuid;

  update compute_environments environment
     set environment_definition_id = definition.id
    from compute_environment_definitions definition
   where definition.owner_user_id = environment.owner_user_id
     and definition.kind = environment.kind
     and definition.ownership = 'built_in';

  alter table compute_environments
    alter column environment_definition_id set not null,
    add foreign key (environment_definition_id, owner_user_id)
      references compute_environment_definitions (id, owner_user_id)
      on delete restrict;

  create index compute_environments_definition_idx
    on compute_environments (owner_user_id, environment_definition_id, id);

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
