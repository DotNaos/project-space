export const computeInventoryMigrationId = '0030_compute_inventory';

export const computeInventoryMigrationSql = `
  create table compute_platforms (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    kind text not null check (
      kind in ('local', 'github_codespaces', 'cloud_sandbox', 'kubernetes', 'virtualization', 'other')
    ),
    name text not null check (btrim(name) <> '' and char_length(name) <= 80),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, kind, name)
  );

  create table compute_hosts (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    platform_id uuid not null,
    identity_version integer not null check (identity_version > 0),
    identity_key text not null check (identity_key ~ '^[A-Za-z0-9:_-]{8,256}$'),
    identity_resolution text not null default 'resolved'
      check (identity_resolution in ('resolved', 'conflict')),
    name text not null check (btrim(name) <> '' and char_length(name) <= 80),
    resources jsonb check (resources is null or jsonb_typeof(resources) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, platform_id, identity_version, identity_key),
    foreign key (platform_id, owner_user_id)
      references compute_platforms (id, owner_user_id)
      on delete cascade
  );

  create table compute_environments (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    platform_id uuid not null,
    host_id uuid,
    parent_environment_id uuid,
    identity_version integer not null check (identity_version > 0),
    identity_key text not null check (identity_key ~ '^[A-Za-z0-9:_-]{8,256}$'),
    kind text not null check (
      kind in (
        'native_macos', 'native_windows', 'native_linux', 'wsl', 'docker', 'devbox',
        'github_codespace', 'cloud_sandbox', 'kubernetes_workload', 'virtual_machine', 'other'
      )
    ),
    name text not null check (btrim(name) <> '' and char_length(name) <= 128),
    host_resolution text not null check (
      host_resolution in ('verified', 'manual', 'unresolved', 'conflict', 'not_applicable')
    ),
    host_evidence text not null check (
      host_evidence in ('provider', 'tpm', 'smbios', 'host_broker', 'user', 'none')
    ),
    resource_mode text not null check (resource_mode in ('dedicated', 'shared', 'exclusive')),
    resources jsonb check (resources is null or jsonb_typeof(resources) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, platform_id, identity_version, identity_key),
    foreign key (platform_id, owner_user_id)
      references compute_platforms (id, owner_user_id)
      on delete cascade,
    foreign key (host_id, owner_user_id)
      references compute_hosts (id, owner_user_id)
      on delete restrict,
    foreign key (parent_environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict,
    check (
      (host_resolution in ('verified', 'manual') and host_id is not null) or
      (host_resolution in ('unresolved', 'not_applicable') and host_id is null) or
      host_resolution = 'conflict'
    )
  );

  create table connector_compute_environments (
    connector_id text not null check (btrim(connector_id) <> ''),
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    environment_id uuid not null,
    association_source text not null default 'legacy'
      check (association_source in ('legacy', 'connector', 'provider', 'manual')),
    associated_at timestamptz not null default now(),
    primary key (owner_user_id, connector_id),
    foreign key (connector_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade,
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict
  );

  create index compute_environments_host_idx
    on compute_environments (owner_user_id, host_id, parent_environment_id);
  create index connector_compute_environments_environment_idx
    on connector_compute_environments (owner_user_id, environment_id, connector_id);

  create function project_space_uuid_from_text(value text) returns uuid
  language sql immutable strict as $$
    select (
      substr(md5(value), 1, 8) || '-' || substr(md5(value), 9, 4) || '-4' ||
      substr(md5(value), 14, 3) || '-a' || substr(md5(value), 18, 3) || '-' ||
      substr(md5(value), 21, 12)
    )::uuid
  $$;

  create function project_space_ensure_connector_environment() returns trigger
  language plpgsql as $$
  declare
    platform_id_value uuid;
    environment_id_value uuid;
    environment_kind_value text;
    environment_name_value text;
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

    insert into compute_platforms (id, owner_user_id, kind, name)
    values (platform_id_value, new.user_id, 'local', 'Local & self-hosted')
    on conflict (id, owner_user_id) do nothing;

    insert into compute_environments (
      id, owner_user_id, platform_id, identity_version, identity_key, kind, name,
      host_resolution, host_evidence, resource_mode
    ) values (
      environment_id_value, new.user_id, platform_id_value, 1,
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

  create trigger machine_memberships_compute_environment
  after insert or update of user_id, machine_id on machine_memberships
  for each row execute function project_space_ensure_connector_environment();

  insert into compute_platforms (id, owner_user_id, kind, name)
  select distinct
    project_space_uuid_from_text('project-space:platform:local:' || user_id),
    user_id,
    'local',
    'Local & self-hosted'
  from machine_memberships
  on conflict (id, owner_user_id) do nothing;

  insert into compute_hosts (
    id, owner_user_id, platform_id, identity_version, identity_key, name
  )
  select
    machine.id,
    machine.owner_user_id,
    project_space_uuid_from_text('project-space:platform:local:' || machine.owner_user_id),
    1,
    'account:' || md5('host:' || machine.owner_user_id || ':' || machine.id::text) ||
      md5('manual:' || machine.owner_user_id || ':' || machine.id::text),
    machine.name
  from physical_machines machine
  on conflict (id, owner_user_id) do nothing;

  insert into compute_environments (
    id, owner_user_id, platform_id, host_id, identity_version, identity_key, kind, name,
    host_resolution, host_evidence, resource_mode
  )
  select
    project_space_uuid_from_text(
      'project-space:environment:connector:' || member.user_id || ':' || member.machine_id
    ),
    member.user_id,
    project_space_uuid_from_text('project-space:platform:local:' || member.user_id),
    physical.physical_machine_id,
    1,
    'account:' || md5('environment:' || member.user_id || ':' || member.machine_id) ||
      md5('connector:' || member.user_id || ':' || member.machine_id),
    case identity.operating_system
      when 'darwin' then 'native_macos'
      when 'windows' then 'native_windows'
      when 'linux' then 'native_linux'
      else 'other'
    end,
    coalesce(nullif(identity.name, ''), member.machine_id),
    case when physical.physical_machine_id is null then 'unresolved' else 'manual' end,
    case when physical.physical_machine_id is null then 'none' else 'user' end,
    'dedicated'
  from machine_memberships member
  left join machine_identities identity
    on identity.id = member.machine_id and identity.owner_user_id = member.user_id
  left join physical_machine_connectors physical
    on physical.connector_id = member.machine_id and physical.owner_user_id = member.user_id
  on conflict (id, owner_user_id) do nothing;

  insert into connector_compute_environments (
    connector_id, owner_user_id, environment_id, association_source, associated_at
  )
  select
    member.machine_id,
    member.user_id,
    project_space_uuid_from_text(
      'project-space:environment:connector:' || member.user_id || ':' || member.machine_id
    ),
    'legacy',
    member.created_at
  from machine_memberships member
  on conflict (owner_user_id, connector_id) do nothing;
`;
