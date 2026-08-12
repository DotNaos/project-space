export const connectorResponsibilityIds = [
  'registration_environment_identity',
  'online_status',
  'remote_command_execution',
  'project_worktree_discovery',
  'codex_version_launch',
  'codex_streaming_steering',
  'dev_server_lifecycle',
  'private_network_publication',
  'resource_reporting',
  'self_update'
] as const;

export type ConnectorResponsibilityId = typeof connectorResponsibilityIds[number];
export type ConnectorReplacementState =
  | 'additive_boundary_available'
  | 'primary_path_pending'
  | 'runtime_proof_pending';

export interface ConnectorRetirementEntry {
  canonicalOwner: string;
  id: ConnectorResponsibilityId;
  migrationIssue: 646 | 647 | 648 | 649;
  replacementIssues: readonly number[];
  replacementState: ConnectorReplacementState;
  responsibility: string;
  rollback: string;
  verification: string;
}

export const connectorRetirementLedger: readonly ConnectorRetirementEntry[] = [
  {
    canonicalOwner: 'Environment bootstrap and immutable Environment Instance identity',
    id: 'registration_environment_identity',
    migrationIssue: 648,
    replacementIssues: [620, 648],
    replacementState: 'primary_path_pending',
    responsibility: 'Registration and environment identity',
    rollback: 'Keep the versioned Connector enrollment endpoint during the deprecation window.',
    verification: 'Bootstrap creates an Environment Instance without changing or reusing any legacy ID.'
  },
  {
    canonicalOwner: 'Access routes, provider state, Runtime Sessions, and optional project-hostd',
    id: 'online_status',
    migrationIssue: 649,
    replacementIssues: [621, 622, 625, 627, 649],
    replacementState: 'runtime_proof_pending',
    responsibility: 'Online status',
    rollback: 'Continue reading legacy status only as labelled compatibility evidence.',
    verification: 'Fresh, stale, partial, and unavailable fixtures stay truthful without Connector presence.'
  },
  {
    canonicalOwner: 'Authorized SSH control gateway over an approved private-network route',
    id: 'remote_command_execution',
    migrationIssue: 647,
    replacementIssues: [622, 623, 647],
    replacementState: 'primary_path_pending',
    responsibility: 'Remote command execution',
    rollback: 'Preserve the legacy command endpoint as an alias through the same resolver and policy.',
    verification: 'Canonical and alias requests resolve one Environment Instance and share authorization.'
  },
  {
    canonicalOwner: 'Typed Project CLI inventory and worktree operations',
    id: 'project_worktree_discovery',
    migrationIssue: 647,
    replacementIssues: [621, 623, 647],
    replacementState: 'primary_path_pending',
    responsibility: 'Project and worktree discovery',
    rollback: 'Keep the versioned project registry read path while canonical discovery proves complete.',
    verification: 'Local, WSL, dual-boot, and hostless inventories and worktrees remain deterministic.'
  },
  {
    canonicalOwner: 'Pinned Workspace Runtime manifest and Project CLI launch',
    id: 'codex_version_launch',
    migrationIssue: 647,
    replacementIssues: [624, 647],
    replacementState: 'primary_path_pending',
    responsibility: 'Codex version and launch',
    rollback: 'Retain the last known compatible Connector launch alias without installing another tool version.',
    verification: 'A Worktree launches its pinned Runtime generation without a permanent Connector.'
  },
  {
    canonicalOwner: 'Outbound Workspace Runtime and Codex App Server WebSocket channels',
    id: 'codex_streaming_steering',
    migrationIssue: 647,
    replacementIssues: [625, 626, 637, 647],
    replacementState: 'runtime_proof_pending',
    responsibility: 'Codex streaming and steering',
    rollback: 'Keep reconnect-safe compatibility routing until outbound resume is proven.',
    verification: 'Start, attach, steer, reconnect, resume, and stop work without inbound Connector control.'
  },
  {
    canonicalOwner: 'Project CLI lifecycle plus outbound Workspace Runtime events',
    id: 'dev_server_lifecycle',
    migrationIssue: 647,
    replacementIssues: [624, 625, 647],
    replacementState: 'primary_path_pending',
    responsibility: 'Development-server lifecycle',
    rollback: 'Keep legacy start and stop aliases routed through canonical target authorization.',
    verification: 'Start, inspect, publish, reconnect, and stop survive Runtime generation changes.'
  },
  {
    canonicalOwner: 'Provider-neutral Private Network and Access Route adapters',
    id: 'private_network_publication',
    migrationIssue: 647,
    replacementIssues: [622, 647],
    replacementState: 'primary_path_pending',
    responsibility: 'Private-network publication',
    rollback: 'Preserve the existing route only as typed provider evidence, never as identity.',
    verification: 'Tailscale and WireGuard fixtures select the same authorized route contract.'
  },
  {
    canonicalOwner: 'Workspace Runtime telemetry and optional outbound project-hostd',
    id: 'resource_reporting',
    migrationIssue: 649,
    replacementIssues: [625, 627, 649],
    replacementState: 'runtime_proof_pending',
    responsibility: 'Resource reporting',
    rollback: 'Retain labelled legacy readings until fresh canonical telemetry is observed.',
    verification: 'Runtime and Host evidence stays bounded, attributable, partial, stale, or unavailable.'
  },
  {
    canonicalOwner: 'Explicit Project CLI update and rare scoped project-hostd upgrade',
    id: 'self_update',
    migrationIssue: 648,
    replacementIssues: [627, 648],
    replacementState: 'primary_path_pending',
    responsibility: 'Connector self-update',
    rollback: 'Keep signed compatibility artifacts until the final removal rollback window closes.',
    verification: 'Canonical setup never installs or silently updates a permanent Connector service.'
  }
];

export const connectorRemovalGate = {
  finalRemovalIssue: 650,
  identityPolicy: 'Legacy Connector and machine IDs are never reinterpreted as canonical IDs.',
  requiredEvidence: [
    'all_replacements_deployed',
    'runtime_proof_complete',
    'rollback_drill_complete',
    'deprecation_window_configured',
    'compatibility_usage_classified',
    'zero_successful_legacy_use_for_full_window',
    'legacy_failure_contract_released'
  ] as const,
  state: 'blocked' as const
};
