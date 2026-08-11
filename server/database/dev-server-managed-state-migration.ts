export const devServerManagedStateMigrationId = '0038_dev_server_managed_states';

export const devServerManagedStateMigrationSql = `
  alter table dev_server_sessions
    drop constraint if exists dev_server_sessions_state_check;

  alter table dev_server_sessions
    add constraint dev_server_sessions_state_check check (
      state in (
        'starting', 'running', 'local-only', 'stopping', 'stopped',
        'failed', 'stale', 'error'
      )
    );

  drop index if exists dev_server_sessions_one_active_per_worktree;
  drop index if exists dev_server_sessions_one_active_per_server;

  create unique index dev_server_sessions_one_active_per_server
    on dev_server_sessions (machine_id, worktree_id, server_id)
    where state in ('starting', 'running', 'local-only', 'stopping');
`;
