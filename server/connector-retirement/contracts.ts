import {
  connectorResponsibilityIds,
  type ConnectorResponsibilityId
} from '../../src/shared/connector-retirement-ledger';

export const connectorCompatibilityCatalogVersion = 'connector-compatibility.v1';
export const connectorCompatibilityUnattributedCatalogVersion =
  `${connectorCompatibilityCatalogVersion}.owner-unattributed`;

export const connectorCompatibilitySurfaces = [
  { id: 'connector.enrollment.http.v1', responsibilityId: 'registration_environment_identity' },
  { id: 'connector.credentials.http.v1', responsibilityId: 'registration_environment_identity' },
  { id: 'connector.presence.websocket.v2', responsibilityId: 'online_status' },
  { id: 'connector.overview.http.v1', responsibilityId: 'online_status' },
  { id: 'connector.machine-list.cli.v1', responsibilityId: 'online_status' },
  { id: 'connector.machine-show.cli.v1', responsibilityId: 'online_status' },
  { id: 'connector.command.remote.v2', responsibilityId: 'remote_command_execution' },
  { id: 'connector.workspace-command.websocket.v1', responsibilityId: 'remote_command_execution' },
  { id: 'connector.project-registry.http.v1', responsibilityId: 'project_worktree_discovery' },
  { id: 'connector.project-registry.websocket.v2', responsibilityId: 'project_worktree_discovery' },
  { id: 'connector.project-registry.owner-http.v1', responsibilityId: 'project_worktree_discovery' },
  { id: 'connector.codex-models.websocket.v1', responsibilityId: 'codex_version_launch' },
  { id: 'connector.codex-sessions-launch.websocket.v1', responsibilityId: 'codex_version_launch' },
  { id: 'connector.codex-chat.websocket.v1', responsibilityId: 'codex_streaming_steering' },
  { id: 'connector.codex-sessions-control.websocket.v1', responsibilityId: 'codex_streaming_steering' },
  { id: 'connector.dev-server.command.v1', responsibilityId: 'dev_server_lifecycle' },
  { id: 'connector.private-network.http.v1', responsibilityId: 'private_network_publication' },
  { id: 'connector.private-network.websocket.v2', responsibilityId: 'private_network_publication' },
  { id: 'connector.resource-report.http.v1', responsibilityId: 'resource_reporting' },
  { id: 'connector.resource-report.websocket.v2', responsibilityId: 'resource_reporting' },
  { id: 'connector.installer-update.http.v1', responsibilityId: 'self_update' },
  { id: 'connector.runtime-maintenance.websocket.v2', responsibilityId: 'self_update' },
  { id: 'connector.runtime-stop.websocket.v1', responsibilityId: 'self_update' }
] as const satisfies readonly {
  id: string;
  responsibilityId: ConnectorResponsibilityId;
}[];

export type ConnectorCompatibilitySurface = typeof connectorCompatibilitySurfaces[number]['id'];

export interface ConnectorCompatibilityUsageRow {
  firstSuccessfulUseAt: string;
  lastSuccessfulUseAt: string;
  successfulUseCount: number;
  surface: ConnectorCompatibilitySurface;
}

export interface ConnectorCompatibilityObservation {
  catalogVersion: string;
  continuousSince: string;
  observedAt: string;
}

export interface ConnectorCompatibilityUsageStore {
  beginRecorderSession(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    startedAt: string,
    maximumGapSeconds: number
  ): Promise<void>;
  checkpoint(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    observedAt: string,
    maximumGapSeconds: number,
    resetContinuity?: boolean
  ): Promise<void>;
  list(ownerUserId: string): Promise<{
    observation?: ConnectorCompatibilityObservation;
    usage: ConnectorCompatibilityUsageRow[];
  }>;
  listObservedOwners(): Promise<string[]>;
  recordSuccess(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    surface: ConnectorCompatibilitySurface,
    completedAt: string,
    maximumGapSeconds: number
  ): Promise<void>;
  closeRecorderSession(sessionId: string, closedAt: string): Promise<void>;
}

export interface ConnectorReplacementProof {
  deployedRevision: string;
  rollbackDrillAt: string;
  runtimeProofRef: string;
}

export interface ConnectorRetirementConfig {
  deprecationSunsetAt?: string;
  failureContractReleased: boolean;
  legacyGlobalCredentialDisabled: boolean;
  maximumEvidenceAgeSeconds: number;
  observationStartedAt?: string;
  replacementProofs: Partial<Record<ConnectorResponsibilityId, ConnectorReplacementProof>>;
  replacementProofsVerified: boolean;
  requiredObservationSeconds: number;
}

export function isConnectorCompatibilitySurface(
  value: unknown
): value is ConnectorCompatibilitySurface {
  return typeof value === 'string' && connectorCompatibilitySurfaces.some(({ id }) => id === value);
}

export function connectorCompatibilityCatalogIsComplete() {
  const classified = new Set(connectorCompatibilitySurfaces.map(({ responsibilityId }) =>
    responsibilityId
  ));
  return connectorResponsibilityIds.every((id) => classified.has(id));
}
