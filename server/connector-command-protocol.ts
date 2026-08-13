import type {
  ConnectorProjectRegistryResult
} from '../src/shared/project-space-api';
import {
  codexDaemonEvidenceIsConsistent,
  type CodexDaemonEvidence
} from '../src/shared/codex-daemon-api';
import { isConnectorComputeMetadata } from './connector-topology-metadata';
import {
  isConnectorCodexHubMessage,
  isConnectorCodexMachineMessage
} from './connector-command-codex-protocol';
import { isConnectorRuntimeMetadata } from './connector-runtime-metadata';
import {
  isConnectorRuntimeMaintenanceDecision
} from './connector-runtime-registration-decision';
import {
  isConnectorEnvironmentRecord,
  isConnectorExecutionScopeId
} from './connector-topology-metadata';
export type { ConnectorHubMessage, ConnectorMachineMessage } from './connector-command-message-types';
import type { ConnectorHubMessage, ConnectorMachineMessage } from './connector-command-message-types';

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
      'compute',
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
    (connector.compute === undefined || isConnectorComputeMetadata(connector.compute)) &&
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

export function isConnectorHubMessage(value: unknown): value is ConnectorHubMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (isConnectorCodexHubMessage(value)) return true;

  if (value.type === 'connector.register') {
    return typeof value.token === 'string' && hasRegistryPayload(value);
  }
  if (value.type === 'connector.registry') {
    return hasRegistryPayload(value);
  }
  return false;
}

export function isConnectorMachineMessage(value: unknown): value is ConnectorMachineMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
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
