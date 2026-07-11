export const machineConnectionMigrationSql = `
  alter table connector_credentials
    add constraint connector_credentials_id_machine_unique
    unique (id, machine_id);

  create table machine_identities (
    id text primary key
      check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    owner_user_id text not null
      check (btrim(owner_user_id) <> '' and char_length(owner_user_id) <= 256),
    public_key text not null unique
      check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
    name text not null
      check (btrim(name) <> '' and char_length(name) <= 64),
    hostname text not null
      check (hostname ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    operating_system text not null
      check (operating_system in ('darwin', 'linux', 'windows')),
    architecture text not null
      check (architecture in ('amd64', 'arm64')),
    client_version text not null
      check (client_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$'),
    current_credential_id uuid,
    created_at timestamptz not null,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    check (last_seen_at is null or last_seen_at >= created_at),
    check (revoked_at is null or revoked_at >= created_at),
    constraint machine_identities_owner_membership_fk
      foreign key (id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      deferrable initially deferred,
    constraint machine_identities_current_credential_fk
      foreign key (current_credential_id, id)
      references connector_credentials (id, machine_id)
      deferrable initially deferred
  );

  create index machine_identities_owner_idx
    on machine_identities (owner_user_id, created_at desc);

  create table machine_connection_requests (
    id uuid primary key,
    poll_token_hash text not null unique
      check (poll_token_hash ~ '^[0-9a-f]{64}$'),
    public_key text not null
      check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
    name text not null
      check (btrim(name) <> '' and char_length(name) <= 64),
    hostname text not null
      check (hostname ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    operating_system text not null
      check (operating_system in ('darwin', 'linux', 'windows')),
    architecture text not null
      check (architecture in ('amd64', 'arm64')),
    client_version text not null
      check (client_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$'),
    status text not null
      check (status in ('pending', 'approved', 'denied', 'consumed', 'expired')),
    approval_challenge text
      check (approval_challenge is null or approval_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    approved_by_user_id text
      check (
        approved_by_user_id is null
        or (btrim(approved_by_user_id) <> '' and char_length(approved_by_user_id) <= 256)
      ),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    approved_at timestamptz,
    denied_at timestamptz,
    consumed_at timestamptz,
    check (expires_at > created_at),
    check (approved_at is null or (approved_at >= created_at and approved_at < expires_at)),
    check (denied_at is null or (denied_at >= created_at and denied_at < expires_at)),
    check (consumed_at is null or (consumed_at >= created_at and consumed_at < expires_at)),
    check (
      (status = 'pending'
        and approval_challenge is null
        and approved_by_user_id is null
        and approved_at is null
        and denied_at is null
        and consumed_at is null)
      or
      (status = 'approved'
        and approval_challenge is not null
        and approved_by_user_id is not null
        and approved_at is not null
        and denied_at is null
        and consumed_at is null)
      or
      (status = 'denied'
        and approval_challenge is null
        and approved_by_user_id is null
        and approved_at is null
        and denied_at is not null
        and consumed_at is null)
      or
      (status = 'consumed'
        and approval_challenge is not null
        and approved_by_user_id is not null
        and approved_at is not null
        and denied_at is null
        and consumed_at is not null
        and consumed_at >= approved_at)
      or
      (status = 'expired'
        and denied_at is null
        and consumed_at is null
        and (
          (approval_challenge is null
            and approved_by_user_id is null
            and approved_at is null)
          or
          (approval_challenge is not null
            and approved_by_user_id is not null
            and approved_at is not null)
        ))
    )
  );

  create index machine_connection_requests_public_key_idx
    on machine_connection_requests (public_key, status, expires_at desc);

  create index machine_connection_requests_cleanup_idx
    on machine_connection_requests (expires_at, id);

  create table machine_connection_rate_events (
    id bigint generated always as identity primary key,
    requester_hash text not null
      check (requester_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null
  );

  create index machine_connection_rate_events_requester_idx
    on machine_connection_rate_events (requester_hash, created_at desc);

  create index machine_connection_rate_events_cleanup_idx
    on machine_connection_rate_events (created_at, id);
`;
