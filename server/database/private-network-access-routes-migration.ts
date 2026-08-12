export const privateNetworkAccessRoutesMigrationId = '0040_private_network_access_routes';

export const privateNetworkAccessRoutesMigrationSql = `
  create table private_networks (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    name text not null check (btrim(name) <> '' and char_length(name) <= 128),
    provider_kind text not null check (provider_kind in ('tailscale', 'wireguard', 'other')),
    provider_reference text not null check (
      btrim(provider_reference) <> '' and char_length(provider_reference) <= 256
    ),
    approval_state text not null check (approval_state in ('approved', 'pending', 'revoked')),
    enabled boolean not null default true,
    availability text not null check (availability in ('available', 'unavailable', 'unknown')),
    last_verified_at timestamptz,
    verified_until timestamptz,
    credential_reference text check (
      credential_reference is null or (
        credential_reference ~ '^op://[^/[:space:]]+/[^/[:space:]]+/.+$' and
        char_length(credential_reference) <= 512
      )
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, provider_kind, provider_reference),
    unique (id, owner_user_id, provider_kind),
    check ((last_verified_at is null) = (verified_until is null)),
    check (verified_until is null or verified_until > last_verified_at),
    check (availability <> 'available' or last_verified_at is not null)
  );

  create index private_networks_owner_status_idx
    on private_networks (owner_user_id, approval_state, enabled, provider_kind, id);

  create table access_routes (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    environment_id uuid,
    host_id uuid,
    private_network_id uuid,
    route_kind text not null check (
      route_kind in ('ssh_private_network', 'provider_native', 'host_console', 'hostd')
    ),
    provider_kind text check (
      provider_kind is null or provider_kind in ('tailscale', 'wireguard', 'other')
    ),
    capabilities text[] not null check (
      cardinality(capabilities) > 0 and capabilities <@ array[
        'project_cli', 'interactive_shell', 'provider_exec',
        'host_console', 'host_power', 'hostd_telemetry'
      ]::text[]
    ),
    priority integer not null default 0 check (priority between 0 and 1000),
    enabled boolean not null default true,
    policy_state text not null check (policy_state in ('approved', 'blocked', 'unknown')),
    allowed_gateway_ids text[] not null default '{}' check (
      cardinality(allowed_gateway_ids) <= 64
    ),
    requires_interactive_approval boolean not null default false,
    availability text not null check (availability in ('available', 'unavailable', 'unknown')),
    last_verified_at timestamptz,
    verified_until timestamptz,
    freshness_seconds integer not null check (freshness_seconds between 1 and 86400),
    target_identity_revision text not null check (
      target_identity_revision ~ '^[A-Za-z0-9:._-]+$' and
      char_length(target_identity_revision) between 8 and 256
    ),
    private_address text check (
      private_address is null or (
        btrim(private_address) <> '' and char_length(private_address) <= 253 and
        private_address !~ '[[:space:]/@]' and (
          private_address ~ '^10\\.' or private_address ~ '^192\\.168\\.' or
          private_address ~ '^172\\.(1[6-9]|2[0-9]|3[01])\\.' or
          private_address ~ '^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.' or
          private_address ~* '^f[cd][0-9a-f]*:' or
          private_address ~* '^[a-z0-9.-]+\\.ts\\.net$'
        )
      )
    ),
    ssh_port integer check (ssh_port between 1 and 65535),
    ssh_user text check (
      ssh_user is null or ssh_user ~ '^[A-Za-z_][A-Za-z0-9._-]{0,63}$'
    ),
    ssh_host_key_sha256 text check (
      ssh_host_key_sha256 is null or ssh_host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'
    ),
    credential_reference text check (
      credential_reference is null or (
        credential_reference ~ '^op://[^/[:space:]]+/[^/[:space:]]+/.+$' and
        char_length(credential_reference) <= 512
      )
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict,
    foreign key (host_id, owner_user_id)
      references compute_hosts (id, owner_user_id) on delete restrict,
    foreign key (private_network_id, owner_user_id, provider_kind)
      references private_networks (id, owner_user_id, provider_kind) on delete restrict,
    check ((environment_id is null) <> (host_id is null)),
    check ((last_verified_at is null) = (verified_until is null)),
    check (verified_until is null or verified_until > last_verified_at),
    check (availability <> 'available' or last_verified_at is not null),
    check (
      not (capabilities && array['interactive_shell', 'host_console', 'host_power']::text[]) or
      requires_interactive_approval
    ),
    check (
      route_kind <> 'ssh_private_network' or
      capabilities <@ array['project_cli', 'interactive_shell']::text[]
    ),
    check (
      route_kind <> 'provider_native' or
      capabilities <@ array['project_cli', 'interactive_shell', 'provider_exec']::text[]
    ),
    check (
      route_kind <> 'host_console' or
      capabilities <@ array['host_console', 'host_power']::text[]
    ),
    check (
      route_kind <> 'hostd' or capabilities <@ array['hostd_telemetry']::text[]
    ),
    check (
      route_kind <> 'ssh_private_network' or (
        environment_id is not null and host_id is null and private_network_id is not null and
        provider_kind is not null and private_address is not null and ssh_port is not null and
        ssh_user is not null and ssh_host_key_sha256 is not null and credential_reference is not null
      )
    ),
    check (
      route_kind <> 'provider_native' or (
        environment_id is not null and host_id is null and private_network_id is null
      )
    ),
    check (route_kind <> 'host_console' or host_id is not null)
  );

  create index access_routes_environment_idx
    on access_routes (owner_user_id, environment_id, enabled, priority desc, id);
  create index access_routes_host_idx
    on access_routes (owner_user_id, host_id, enabled, priority desc, id);
`;
