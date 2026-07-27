import type {
  CodexChatRequest,
  CodexChatStreamEvent,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  ConnectorProjectRegistryResult,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileRequest,
  MachineFileSystemFileResult,
  MachineFileSystemRequest,
  MachineFileSystemRootResult,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryMutationResult,
  MachineDirectoryRenameRequest,
  MachineProjectWorktreesRequest,
  MachineTerminalCommandRequest,
  ProjectCliCommandRequest,
  ProjectCliCommandResult,
  ProjectWorktreeRecord,
  TerminalCommandResult
} from '../src/shared/project-space-api';
import {
  codexDaemonEvidenceIsConsistent,
  type CodexDaemonEvidence
} from '../src/shared/codex-daemon-api';
import {
  isConnectorDevServerResult,
  isConnectorDevServerListResult,
  isConnectorDevServerListWireRequest,
  isConnectorDevServerWireRequest,
  type ConnectorDevServerResult,
  type ConnectorDevServerListResult,
  type ConnectorDevServerListWireRequest,
  type ConnectorDevServerWireRequest
} from './connector-dev-server-contract';
import {
  isConnectorWorktreeActionResult,
  isConnectorWorktreeActionWireRequest,
  type ConnectorWorktreeActionResult,
  type ConnectorWorktreeActionWireRequest
} from './connector-worktree-action-contract';
import {
  isConnectorCodexHubMessage,
  isConnectorCodexMachineMessage,
  type ConnectorCodexHubMessage,
  type ConnectorCodexMachineMessage
} from './connector-command-codex-protocol';
import {
  isConnectorRuntimeHubCommandMessage,
  isConnectorRuntimeMachineCommandMessage,
  isConnectorRuntimeMetadata,
  type ConnectorRuntimeHubCommandMessage,
  type ConnectorRuntimeMachineCommandMessage
} from './connector-runtime-command-routing';
import {
  isConnectorRuntimeStopHubMessage,
  isConnectorRuntimeStopMachineMessage,
  type ConnectorRuntimeStopHubMessage,
  type ConnectorRuntimeStopMachineMessage
} from './connector-runtime-stop-routing';
import {
  isConnectorRuntimeMaintenanceDecision,
  type ConnectorRuntimeMaintenanceDecision
} from './connector-runtime-registration-decision';
import {
  isConnectorEnvironmentRecord,
  isConnectorExecutionScopeId
} from './connector-topology-metadata';

export type ConnectorHubMessage =
  | ConnectorRuntimeHubCommandMessage
  | ConnectorRuntimeStopHubMessage
  | ConnectorCodexHubMessage
  | {
      payload: ConnectorProjectRegistryResult;
      token: string;
      type: 'connector.register';
    }
  | {
      payload: ConnectorProjectRegistryResult;
      type: 'connector.registry';
    }
  | {
      id: string;
      payload: CodexModelCatalogueResult;
      type: 'codex.models.result';
    }
  | {
      id: string;
      payload: CodexChatStreamEvent;
      type: 'codex.chat.event';
    }
  | {
      id: string;
      type: 'codex.chat.complete';
    }
  | {
      id: string;
      payload: ProjectCliCommandResult;
      type: 'project-cli.result';
    }
  | {
      id: string;
      payload: ConnectorDevServerResult;
      type: 'dev-server.inspect.result';
    }
  | {
      id: string;
      payload: ConnectorDevServerListResult;
      type: 'dev-server.list.result';
    }
  | {
      id: string;
      payload: ConnectorDevServerResult;
      type: 'dev-server.start.result';
    }
  | {
      id: string;
      payload: ConnectorDevServerResult;
      type: 'dev-server.stop.result';
    }
  | {
      id: string;
      payload: ConnectorWorktreeActionResult;
      type: 'worktree.action.result';
    }
  | {
      id: string;
      payload: TerminalCommandResult;
      type: 'terminal.result';
    }
  | {
      id: string;
      payload: ProjectWorktreeRecord[];
      type: 'worktrees.result';
    }
  | {
      id: string;
      payload: { message: string };
      type: 'worktrees.error';
    }
  | {
      id: string;
      payload: MachineFileSystemRootResult;
      type: 'filesystem.root.result';
    }
  | {
      id: string;
      payload: MachineFileSystemDirectoryResult;
      type: 'filesystem.directory.result';
    }
  | {
      id: string;
      payload: MachineFileSystemFileResult;
      type: 'filesystem.file.result';
    }
  | {
      id: string;
      payload: MachineDirectoryMutationResult;
      type:
        | 'filesystem.folder.create.result'
        | 'filesystem.folder.rename.result'
        | 'filesystem.folder.delete.result';
    };

export type ConnectorMachineMessage =
  | {
      generation: number;
      maintenance?: ConnectorRuntimeMaintenanceDecision;
      type: 'connector.registered';
    }
  | ConnectorRuntimeMachineCommandMessage
  | ConnectorRuntimeStopMachineMessage
  | ConnectorCodexMachineMessage
  | { id: string; type: 'connector.command.cancel' }
  | { id: string; payload: CodexModelCatalogueRequest; type: 'codex.models' }
  | { id: string; payload: CodexChatRequest; type: 'codex.chat' }
  | { id: string; payload: ProjectCliCommandRequest; type: 'project-cli.run' }
  | {
      id: string;
      payload: ConnectorDevServerWireRequest;
      type: 'dev-server.inspect';
    }
  | {
      id: string;
      payload: ConnectorDevServerListWireRequest;
      type: 'dev-server.list';
    }
  | {
      id: string;
      payload: ConnectorDevServerWireRequest;
      type: 'dev-server.start';
    }
  | {
      id: string;
      payload: ConnectorDevServerWireRequest;
      type: 'dev-server.stop';
    }
  | {
      id: string;
      payload: ConnectorWorktreeActionWireRequest;
      type: 'worktree.action';
    }
  | { id: string; payload: MachineTerminalCommandRequest; type: 'terminal.run' }
  | {
      id: string;
      payload: MachineProjectWorktreesRequest;
      type: 'worktrees.list';
    }
  | { id: string; payload: MachineFileSystemRequest; type: 'filesystem.root' }
  | {
      id: string;
      payload: MachineFileSystemDirectoryRequest;
      type: 'filesystem.directory';
    }
  | {
      id: string;
      payload: MachineFileSystemFileRequest;
      type: 'filesystem.file';
    }
  | {
      id: string;
      payload: MachineDirectoryCreateRequest;
      type: 'filesystem.folder.create';
    }
  | {
      id: string;
      payload: MachineDirectoryRenameRequest;
      type: 'filesystem.folder.rename';
    }
  | {
      id: string;
      payload: MachineDirectoryDeleteRequest;
      type: 'filesystem.folder.delete';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasCommandId(value: Record<string, unknown>) {
  return typeof value.id === 'string' && value.id.length > 0;
}

function isCanonicalMachineId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isBoundedString(value: unknown, maximum = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isBoundedMetadata(value: unknown, maximum = 256): value is string {
  return (
    isBoundedString(value, maximum) &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function isOptionalMetadata(value: unknown, maximum = 256) {
  return value === undefined || isBoundedMetadata(value, maximum);
}

function hasUntrustedNetworkMetadata(value: unknown) {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['localName', 'sshUser', 'tailscaleIp']) &&
      isOptionalMetadata(value.localName) &&
      isOptionalMetadata(value.sshUser) &&
      isOptionalMetadata(value.tailscaleIp))
  );
}

function hasBatteryMetadata(value: unknown) {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['percentage', 'state'])) {
    return false;
  }

  const validPercentage =
    typeof value.percentage === 'number' &&
    Number.isFinite(value.percentage) &&
    value.percentage >= 0 &&
    value.percentage <= 100;
  const validState =
    value.state === undefined ||
    value.state === 'charged' ||
    value.state === 'charging' ||
    value.state === 'discharging' ||
    value.state === 'unknown';
  return validPercentage && validState;
}

function hasConnectorMetadata(connector: Record<string, unknown>) {
  const validKind =
    connector.kind === undefined ||
    (isBoundedMetadata(connector.kind, 128) && connector.kind.toLowerCase() !== 'local');
  const validCapabilities =
    connector.capabilities === undefined ||
    (Array.isArray(connector.capabilities) &&
      connector.capabilities.length <= 64 &&
      connector.capabilities.every((entry) => isBoundedMetadata(entry, 128)));

  return (
    hasOnlyKeys(connector, [
      'battery',
      'capabilities',
      'daemon',
      'environment',
      'executionScopeId',
      'kind',
      'machineId',
      'machineName',
      'network',
      'origin',
      'primaryUser',
      'runtime',
      'serviceName'
    ]) &&
    isCanonicalMachineId(connector.machineId) &&
    isBoundedMetadata(connector.machineName) &&
    hasBatteryMetadata(connector.battery) &&
    hasCodexDaemonEvidence(connector.daemon) &&
    (connector.environment === undefined ||
      isConnectorEnvironmentRecord(connector.environment)) &&
    (connector.executionScopeId === undefined ||
      isConnectorExecutionScopeId(connector.executionScopeId)) &&
    hasUntrustedNetworkMetadata(connector.network) &&
    isOptionalMetadata(connector.origin, 2_048) &&
    isOptionalMetadata(connector.primaryUser) &&
    isConnectorRuntimeMetadata(connector.runtime) &&
    isOptionalMetadata(connector.serviceName) &&
    validKind &&
    validCapabilities
  );
}

function hasCodexDaemonEvidence(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'appServerVersion', 'authenticated', 'checkedAt', 'cliVersion', 'compatible',
    'environmentId', 'installed', 'paired', 'reachable', 'remoteControlEnabled',
    'remoteControlState', 'running', 'state'
  ])) return false;
  return typeof value.checkedAt === 'string' &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    [
      value.authenticated, value.compatible, value.installed, value.paired,
      value.reachable, value.remoteControlEnabled, value.running
    ].every((entry) => typeof entry === 'boolean') &&
    ['disabled', 'connecting', 'connected', 'errored', 'unknown']
      .includes(String(value.remoteControlState)) &&
    [
      'ready', 'missing', 'stopped', 'incompatible', 'authorization-required',
      'remote-control-disabled', 'pairing-required', 'connecting', 'unsupported', 'uncertain'
    ].includes(String(value.state)) &&
    [value.appServerVersion, value.cliVersion, value.environmentId]
      .every((entry) => entry === undefined || isBoundedMetadata(entry, 256)) &&
    codexDaemonEvidenceIsConsistent(value as unknown as CodexDaemonEvidence);
}

function hasProject(value: unknown) {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 512) &&
    isBoundedString(value.name, 256) &&
    isBoundedString(value.rootPath) &&
    (value.kind === 'workspace' || value.kind === 'standalone' || value.kind === 'github') &&
    (value.groupId === undefined || isBoundedString(value.groupId, 512))
  );
}

function hasGroup(value: unknown) {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 512) &&
    isBoundedString(value.name, 256) &&
    isBoundedString(value.rootPath) &&
    Array.isArray(value.childProjectIds) &&
    value.childProjectIds.length <= 5_000 &&
    value.childProjectIds.every((id) => isBoundedString(id, 512))
  );
}

function hasRootItem(value: unknown) {
  if (!isRecord(value) || !isBoundedString(value.id, 512) || !isBoundedString(value.label, 256)) {
    return false;
  }
  return value.kind === 'project'
    ? isBoundedString(value.projectId, 512)
    : value.kind === 'group' && isBoundedString(value.groupId, 512);
}

function hasStructureViolation(value: unknown) {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 512) &&
    isBoundedString(value.type, 128) &&
    (value.severity === 'warning' || value.severity === 'error') &&
    isBoundedString(value.path) &&
    isBoundedString(value.relativePath) &&
    isBoundedString(value.name, 256) &&
    isBoundedString(value.title, 512) &&
    isBoundedString(value.detail, 4_096)
  );
}

export function isConnectorProjectRegistryPayload(
  value: unknown
): value is ConnectorProjectRegistryResult {
  if (!isRecord(value) || !isRecord(value.connector) || !isRecord(value.discovery)) {
    return false;
  }
  const { connector, discovery } = value;
  return (
    isBoundedString(value.checkedAt, 64) &&
    hasConnectorMetadata(connector) &&
    Array.isArray(discovery.groups) &&
    discovery.groups.length <= 1_000 &&
    discovery.groups.every(hasGroup) &&
    Array.isArray(discovery.projects) &&
    discovery.projects.length <= 5_000 &&
    discovery.projects.every(hasProject) &&
    Array.isArray(discovery.rootItems) &&
    discovery.rootItems.length <= 6_000 &&
    discovery.rootItems.every(hasRootItem) &&
    typeof discovery.rootPath === 'string' &&
    discovery.rootPath.length <= 4_096 &&
    Array.isArray(discovery.structureViolations) &&
    discovery.structureViolations.length <= 5_000 &&
    discovery.structureViolations.every(hasStructureViolation)
  );
}

function hasRegistryPayload(value: Record<string, unknown>) {
  return isConnectorProjectRegistryPayload(value.payload);
}

function hasStatus(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.status === 'success' || value.status === 'error');
}

function hasTerminalResult(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    typeof value.durationMs === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

function hasFileSystemEntry(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.isProject === undefined || typeof value.isProject === 'boolean') &&
    (value.kind === 'file' || value.kind === 'directory')
  );
}

function hasWorktree(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    /^wt_[a-f0-9]{24}$/.test(value.id) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    (value.branchName === undefined || typeof value.branchName === 'string') &&
    typeof value.detached === 'boolean' &&
    value.detached === (value.branchName === undefined) &&
    (value.headSha === undefined ||
      (typeof value.headSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headSha))) &&
    typeof value.isBase === 'boolean' &&
    (value.kind === 'project-managed' || value.kind === 'codex' || value.kind === 'external') &&
    typeof value.locked === 'boolean' &&
    (value.lockedReason === undefined || typeof value.lockedReason === 'string') &&
    typeof value.prunable === 'boolean' &&
    (value.prunableReason === undefined || typeof value.prunableReason === 'string') &&
    (value.status === 'ready' ||
      value.status === 'locked' ||
      value.status === 'prunable' ||
      value.status === 'missing' ||
      value.status === 'broken' ||
      value.status === 'unavailable') &&
    (value.statusReason === undefined || typeof value.statusReason === 'string')
  );
}

function hasFileResult(value: unknown) {
  if (!hasStatus(value) || typeof value.path !== 'string' || typeof value.name !== 'string') {
    return false;
  }
  if (value.status === 'success' && typeof value.content !== 'string') {
    return false;
  }
  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.modifiedAt === undefined || typeof value.modifiedAt === 'string') &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number') &&
    (value.truncated === undefined || typeof value.truncated === 'boolean')
  );
}

function hasFolderMutationResult(value: unknown) {
  return (
    hasStatus(value) &&
    Array.isArray(value.affectedPaths) &&
    value.affectedPaths.every((path) => typeof path === 'string')
  );
}

export function isConnectorHubMessage(value: unknown): value is ConnectorHubMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (isConnectorRuntimeHubCommandMessage(value)) return true;
  if (isConnectorRuntimeStopHubMessage(value)) return true;
  if (isConnectorCodexHubMessage(value)) return true;

  if (value.type === 'connector.register') {
    return typeof value.token === 'string' && hasRegistryPayload(value);
  }
  if (value.type === 'connector.registry') {
    return hasRegistryPayload(value);
  }
  if (value.type === 'codex.chat.complete') {
    return hasCommandId(value);
  }
  if (value.type === 'codex.chat.event') {
    return (
      hasCommandId(value) &&
      isRecord(value.payload) &&
      (value.payload.type === 'delta' ||
        value.payload.type === 'done' ||
        value.payload.type === 'error')
    );
  }
  if (value.type === 'codex.models.result') {
    return (
      hasCommandId(value) &&
      isRecord(value.payload) &&
      Array.isArray(value.payload.models) &&
      (value.payload.status === 'success' || value.payload.status === 'error')
    );
  }
  if (value.type === 'project-cli.result') {
    return hasCommandId(value) && isRecord(value.payload);
  }
  if (
    value.type === 'dev-server.inspect.result' ||
    value.type === 'dev-server.start.result' ||
    value.type === 'dev-server.stop.result'
  ) {
    return hasCommandId(value) && isConnectorDevServerResult(value.payload);
  }
  if (value.type === 'dev-server.list.result') {
    return hasCommandId(value) && isConnectorDevServerListResult(value.payload);
  }
  if (value.type === 'worktree.action.result') {
    return hasCommandId(value) && isConnectorWorktreeActionResult(value.payload);
  }
  if (value.type === 'terminal.result') {
    return hasCommandId(value) && hasTerminalResult(value.payload);
  }
  if (value.type === 'worktrees.result') {
    return hasCommandId(value) && Array.isArray(value.payload) && value.payload.every(hasWorktree);
  }
  if (value.type === 'worktrees.error') {
    return (
      hasCommandId(value) &&
      isRecord(value.payload) &&
      typeof value.payload.message === 'string'
    );
  }
  if (value.type === 'filesystem.root.result') {
    return (
      hasCommandId(value) &&
      hasStatus(value.payload) &&
      typeof value.payload.homePath === 'string' &&
      typeof value.payload.defaultPath === 'string'
    );
  }
  if (value.type === 'filesystem.directory.result') {
    return (
      hasCommandId(value) &&
      hasStatus(value.payload) &&
      typeof value.payload.path === 'string' &&
      Array.isArray(value.payload.entries) &&
      value.payload.entries.every(hasFileSystemEntry)
    );
  }
  if (
    value.type === 'filesystem.folder.create.result' ||
    value.type === 'filesystem.folder.rename.result' ||
    value.type === 'filesystem.folder.delete.result'
  ) {
    return hasCommandId(value) && hasFolderMutationResult(value.payload);
  }
  return (
    value.type === 'filesystem.file.result' && hasCommandId(value) && hasFileResult(value.payload)
  );
}

export function isConnectorMachineMessage(value: unknown): value is ConnectorMachineMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (isConnectorRuntimeStopMachineMessage(value)) return true;
  if (isConnectorCodexMachineMessage(value)) return true;
  if (value.type === 'connector.registered') {
    return hasOnlyKeys(value, ['generation', 'maintenance', 'type']) &&
      typeof value.generation === 'number' && Number.isSafeInteger(value.generation) &&
      value.generation > 0 && (value.maintenance === undefined ||
        isConnectorRuntimeMaintenanceDecision(value.maintenance));
  }
  if (value.type === 'connector.command.cancel') {
    return hasCommandId(value);
  }
  if (!hasCommandId(value) || !isRecord(value.payload)) {
    return false;
  }
  if (isConnectorRuntimeMachineCommandMessage(value)) return true;
  if (value.type === 'codex.models') {
    return typeof value.payload.cwd === 'string' && typeof value.payload.machineId === 'string';
  }
  if (value.type === 'codex.chat') {
    return (
      typeof value.payload.cwd === 'string' &&
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.prompt === 'string' &&
      Array.isArray(value.payload.messages)
    );
  }
  if (value.type === 'project-cli.run') {
    return true;
  }
  if (value.type === 'worktree.action') {
    return isConnectorWorktreeActionWireRequest(value.payload);
  }
  if (
    value.type === 'dev-server.inspect' ||
    value.type === 'dev-server.start' ||
    value.type === 'dev-server.stop'
  ) {
    const operation = value.type.slice('dev-server.'.length);
    return (
      isConnectorDevServerWireRequest(value.payload) && value.payload.grant.operation === operation
    );
  }
  if (value.type === 'dev-server.list') {
    return (
      isConnectorDevServerListWireRequest(value.payload) && value.payload.grant.operation === 'list'
    );
  }
  if (value.type === 'terminal.run') {
    return typeof value.payload.machineId === 'string' && typeof value.payload.command === 'string';
  }
  if (value.type === 'worktrees.list') {
    return (
      typeof value.payload.machineId === 'string' && typeof value.payload.projectPath === 'string'
    );
  }
  if (value.type === 'filesystem.root') {
    return typeof value.payload.machineId === 'string';
  }
  if (value.type === 'filesystem.directory' || value.type === 'filesystem.file') {
    return typeof value.payload.machineId === 'string' && typeof value.payload.path === 'string';
  }
  if (value.type === 'filesystem.folder.create') {
    return (
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.parentPath === 'string' &&
      typeof value.payload.name === 'string'
    );
  }
  if (value.type === 'filesystem.folder.rename') {
    return (
      typeof value.payload.machineId === 'string' &&
      typeof value.payload.path === 'string' &&
      typeof value.payload.name === 'string'
    );
  }
  if (value.type === 'filesystem.folder.delete') {
    return (
      typeof value.payload.machineId === 'string' &&
      Array.isArray(value.payload.paths) &&
      value.payload.paths.every((path) => typeof path === 'string')
    );
  }
  return false;
}

export function parseConnectorMessage(data: unknown): unknown {
  try {
    const text = typeof data === 'string' ? data : String(data);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
