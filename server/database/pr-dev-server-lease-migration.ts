export const prDevServerLeaseMigrationId = '0025_pr_dev_server_leases';

export const prDevServerLeaseMigrationSql = `
  create table pull_request_dev_server_leases (
    id uuid primary key,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    repository_full_name text not null
      check (repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
    pull_request_number integer not null check (pull_request_number > 0),
    project_id text not null check (btrim(project_id) <> ''),
    worktree_id text not null check (btrim(worktree_id) <> ''),
    branch_name text not null check (btrim(branch_name) <> ''),
    commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
    served_surface text not null
      check (served_surface in ('mobile-prototype', 'desktop-prototype')),
    physical_machine_id uuid not null,
    connector_id text not null check (btrim(connector_id) <> ''),
    server_id text not null check (btrim(server_id) <> ''),
    tailscale_ipv4 inet not null,
    tailscale_port integer not null check (tailscale_port between 1 and 65535),
    tailscale_url text not null check (btrim(tailscale_url) <> ''),
    codex_thread_id text,
    lease_generation bigint not null check (lease_generation > 0),
    heartbeat_at timestamptz not null,
    expires_at timestamptz not null check (expires_at > heartbeat_at),
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (connector_id, owner_user_id)
      references machine_memberships (machine_id, user_id)
      on delete cascade,
    foreign key (physical_machine_id, owner_user_id)
      references physical_machines (id, owner_user_id)
      on delete cascade
  );

  create unique index pull_request_dev_server_leases_current_scope_idx
    on pull_request_dev_server_leases (
      owner_user_id,
      lower(repository_full_name),
      pull_request_number
    )
    where revoked_at is null;

  create index pull_request_dev_server_leases_pr_lookup_idx
    on pull_request_dev_server_leases (
      owner_user_id,
      lower(repository_full_name),
      pull_request_number,
      expires_at desc
    );

  create index pull_request_dev_server_leases_expiry_cleanup_idx
    on pull_request_dev_server_leases (expires_at, id)
    where revoked_at is null;
`;
