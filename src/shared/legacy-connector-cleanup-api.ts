export const legacyConnectorCleanupSchemaVersion = 1 as const;

export type LegacyConnectorCleanupBlockerKind =
  | 'active_credential'
  | 'physical_host_mapping'
  | 'execution_scope'
  | 'environment_reference'
  | 'access_route'
  | 'run_destination'
  | 'task_execution'
  | 'workspace_runtime'
  | 'workspace_command'
  | 'active_operation'
  | 'host_agent'
  | 'codex_route'
  | 'codex_snapshot'
  | 'dev_server'
  | 'connector_operation';

export interface LegacyConnectorCleanupBlocker {
  kind: LegacyConnectorCleanupBlockerKind;
  count: number;
}

export interface LegacyConnectorCleanupReplacement {
  environmentId: string;
  kind: 'tailscale' | 'provider';
}

export interface LegacyConnectorCleanupRecord {
  blockers: readonly LegacyConnectorCleanupBlocker[];
  connectorId: string;
  eligible: boolean;
  environmentId: string;
  fingerprint: string;
  label: string;
  replacement?: LegacyConnectorCleanupReplacement;
}

export interface LegacyConnectorCleanupSnapshot {
  records: readonly LegacyConnectorCleanupRecord[];
  schemaVersion: typeof legacyConnectorCleanupSchemaVersion;
}

export interface LegacyConnectorRemovalTarget {
  connectorId: string;
  fingerprint: string;
}

export interface LegacyConnectorRemovalRequest {
  actorId: string;
  records: readonly LegacyConnectorRemovalTarget[];
  requestId: string;
}

export type LegacyConnectorRemovalOutcome = 'removed' | 'already_removed' | 'blocked' | 'conflict';

export interface LegacyConnectorRemovalResultItem {
  blockers?: readonly LegacyConnectorCleanupBlocker[];
  connectorId: string;
  fingerprint: string;
  outcome: LegacyConnectorRemovalOutcome;
}

export interface LegacyConnectorRemovalResult {
  requestId: string;
  results: readonly LegacyConnectorRemovalResultItem[];
}
