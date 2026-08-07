export const projectSpaceMcpOAuthMigrationId = '0029_project_space_mcp_oauth';

export const projectSpaceMcpOAuthMigrationSql = `
  create table if not exists project_space_mcp_oauth_clients (
    client_id text primary key check (btrim(client_id) <> ''),
    metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists project_space_mcp_oauth_authorizations (
    id uuid primary key,
    client_id text not null references project_space_mcp_oauth_clients(client_id) on delete cascade,
    redirect_uri text not null,
    state text,
    code_challenge text not null,
    scopes text[] not null,
    resource text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );

  create index if not exists project_space_mcp_oauth_authorizations_expiry_idx
    on project_space_mcp_oauth_authorizations (expires_at);

  create table if not exists project_space_mcp_oauth_credentials (
    token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
    kind text not null check (kind in ('authorization_code', 'access_token', 'refresh_token')),
    client_id text not null references project_space_mcp_oauth_clients(client_id) on delete cascade,
    user_id text not null check (btrim(user_id) <> ''),
    user_email text,
    scopes text[] not null,
    redirect_uri text,
    code_challenge text,
    resource text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
  );

  create index if not exists project_space_mcp_oauth_credentials_expiry_idx
    on project_space_mcp_oauth_credentials (expires_at);
  create index if not exists project_space_mcp_oauth_credentials_client_idx
    on project_space_mcp_oauth_credentials (client_id, kind);
`;
