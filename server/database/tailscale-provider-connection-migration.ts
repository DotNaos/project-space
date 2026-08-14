export const tailscaleProviderConnectionMigrationId = '0054_tailscale_provider_connections';

export const tailscaleProviderConnectionMigrationSql = `
  create table tailscale_provider_connections (
    connection_id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    state text not null check (state in ('active', 'revoked')),
    revision bigint not null default 1 check (revision > 0),
    credential_key_id text,
    credential_ciphertext text,
    credential_iv text,
    credential_tag text,
    verified_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (connection_id, owner_user_id),
    unique (connection_id),
    unique (owner_user_id),
    check (
      (credential_key_id is null) = (credential_ciphertext is null) and
      (credential_key_id is null) = (credential_iv is null) and
      (credential_key_id is null) = (credential_tag is null)
    ),
    check (
      (state = 'active' and credential_key_id is not null and revoked_at is null) or
      (state = 'revoked' and credential_key_id is null and revoked_at is not null)
    )
  );

  create index tailscale_provider_connections_owner_state_idx
    on tailscale_provider_connections (owner_user_id, state, updated_at desc);

  create table tailscale_provider_connection_audits (
    id bigserial primary key,
    connection_id uuid not null,
    owner_user_id text not null,
    actor_id text not null check (
      btrim(actor_id) <> '' and char_length(actor_id) <= 256 and actor_id !~ '[[:cntrl:]]'
    ),
    action text not null check (action in ('connected', 'revoked')),
    revision bigint not null check (revision > 0),
    created_at timestamptz not null default now(),
    foreign key (connection_id, owner_user_id)
      references tailscale_provider_connections (connection_id, owner_user_id) on delete restrict
  );

  create index tailscale_provider_connection_audits_owner_connection_idx
    on tailscale_provider_connection_audits (owner_user_id, connection_id, id desc);
`;
