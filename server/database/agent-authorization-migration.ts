export const agentAuthorizationMigrationId = '0033_agent_authorization_operations';

export const agentAuthorizationMigrationSql = `
  create table agent_authorization_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (
      btrim(operation_id) <> '' and char_length(operation_id) <= 128
    ),
    environment_id uuid not null,
    agent_kind text not null check (
      btrim(agent_kind) <> '' and char_length(agent_kind) <= 80
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    connector_id text check (
      connector_id is null or (btrim(connector_id) <> '' and char_length(connector_id) <= 256)
    ),
    connector_generation bigint check (connector_generation is null or connector_generation > 0),
    state text not null check (
      state in (
        'dispatching', 'pending', 'ready', 'cancelled', 'expired',
        'failed', 'ambiguous', 'retryable'
      )
    ),
    dispatch_attempted boolean not null default false,
    deadline_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '30 days',
    primary key (owner_user_id, operation_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict,
    check (
      (connector_id is null and connector_generation is null)
      or (connector_id is not null and connector_generation is not null)
    ),
    check (state <> 'pending' or deadline_at is not null),
    check (expires_at > created_at)
  );

  create unique index agent_authorization_one_unresolved_per_environment
    on agent_authorization_operations (owner_user_id, environment_id, agent_kind)
    where state in ('dispatching', 'pending')
       or (state = 'ambiguous' and dispatch_attempted);

  create index agent_authorization_environment_time_idx
    on agent_authorization_operations (
      owner_user_id, environment_id, agent_kind, created_at desc
    );

  create index agent_authorization_expiry_idx
    on agent_authorization_operations (expires_at);
`;
