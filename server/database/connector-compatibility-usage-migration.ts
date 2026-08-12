export const connectorCompatibilityUsageMigrationId = '0049_connector_compatibility_usage';

// These literals are immutable because the migration checksum is durable.
const surfaces = [
  'connector.enrollment.http.v1',
  'connector.credentials.http.v1',
  'connector.presence.websocket.v2',
  'connector.overview.http.v1',
  'connector.machine-list.cli.v1',
  'connector.machine-show.cli.v1',
  'connector.command.remote.v2',
  'connector.workspace-command.websocket.v1',
  'connector.project-registry.http.v1',
  'connector.project-registry.websocket.v2',
  'connector.project-registry.owner-http.v1',
  'connector.codex-models.websocket.v1',
  'connector.codex-sessions-launch.websocket.v1',
  'connector.codex-chat.websocket.v1',
  'connector.codex-sessions-control.websocket.v1',
  'connector.dev-server.command.v1',
  'connector.private-network.http.v1',
  'connector.private-network.websocket.v2',
  'connector.resource-report.http.v1',
  'connector.resource-report.websocket.v2',
  'connector.installer-update.http.v1',
  'connector.runtime-maintenance.websocket.v2',
  'connector.runtime-stop.websocket.v1'
].map((value) => `'${value}'`).join(', ');

export const connectorCompatibilityUsageMigrationSql = `
  create table if not exists connector_compatibility_usage (
    owner_user_id text not null,
    surface text not null check (surface in (${surfaces})),
    successful_use_count bigint not null
      check (successful_use_count between 1 and 9007199254740991),
    first_successful_use_at timestamptz not null,
    last_successful_use_at timestamptz not null,
    primary key (owner_user_id, surface),
    check (last_successful_use_at >= first_successful_use_at)
  );

  create table if not exists connector_compatibility_observations (
    owner_user_id text primary key,
    catalog_version text not null check (length(catalog_version) between 1 and 128),
    continuous_since timestamptz not null,
    observed_at timestamptz not null
      check (observed_at >= continuous_since),
    recorder_session_id text not null
      check (length(recorder_session_id) between 1 and 128),
    recorder_state text not null check (recorder_state in ('active', 'clean'))
  );

  revoke all on connector_compatibility_usage from public;
  revoke all on connector_compatibility_observations from public;
`;
