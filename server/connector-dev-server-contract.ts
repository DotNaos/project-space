import type {
  DevServerCommandGrant,
  DevServerCapability,
  DevServerConnectorRequest,
  DevServerConnectorResult,
  DevServerListConnectorRequest,
  DevServerListConnectorResult,
  DevServerOperation
} from '../src/shared/project-space-api';

export const connectorDevServerOperations = ['inspect', 'list', 'start', 'stop'] as const;

export type ConnectorDevServerOperation = DevServerOperation;

export interface ConnectorDevServerActor {
  generation: number;
  userId: string;
}

export type ConnectorDevServerCommandGrant = DevServerCommandGrant;
export type ConnectorDevServerTrustedRequest = Omit<DevServerConnectorRequest, 'grant'>;
export type ConnectorDevServerWireRequest = DevServerConnectorRequest;
export type ConnectorDevServerListTrustedRequest = Omit<DevServerListConnectorRequest, 'grant'>;
export type ConnectorDevServerListWireRequest = DevServerListConnectorRequest;
export type ConnectorDevServerAnyTrustedRequest =
  ConnectorDevServerTrustedRequest | ConnectorDevServerListTrustedRequest;
export type ConnectorDevServerAnyWireRequest =
  ConnectorDevServerWireRequest | ConnectorDevServerListWireRequest;

export interface ConnectorDevServerExecutionRequest extends ConnectorDevServerTrustedRequest {
  actor: ConnectorDevServerActor;
  operation: Exclude<ConnectorDevServerOperation, 'list'>;
}

export interface ConnectorDevServerListExecutionRequest extends ConnectorDevServerListTrustedRequest {
  actor: ConnectorDevServerActor;
  operation: 'list';
}

export type ConnectorDevServerResult = DevServerConnectorResult;
export type ConnectorDevServerListResult = DevServerListConnectorResult;

export interface ConnectorDevServerAdapter {
  listDevServers(
    request: ConnectorDevServerListExecutionRequest
  ): Promise<ConnectorDevServerListResult>;
  runDevServerCommand(
    request: ConnectorDevServerExecutionRequest
  ): Promise<ConnectorDevServerResult>;
}

const actionWireRequestKeys = [
  'allowedHosts',
  'expectedHeadSha',
  'grant',
  'machineId',
  'projectId',
  'runTarget',
  'serverId',
  'worktreeId'
] as const;

const listWireRequestKeys = [
  'expectedHeadSha',
  'grant',
  'machineId',
  'projectId',
  'worktreeId'
] as const;

const actionGrantKeys = [
  'allowedHosts',
  'expectedHeadSha',
  'expiresAt',
  'generation',
  'issuedAt',
  'machineId',
  'nonce',
  'operation',
  'projectId',
  'runTarget',
  'serverId',
  'signature',
  'userId',
  'worktreeId'
] as const;

const listGrantKeys = [
  'expectedHeadSha',
  'expiresAt',
  'generation',
  'issuedAt',
  'machineId',
  'nonce',
  'operation',
  'projectId',
  'signature',
  'userId',
  'worktreeId'
] as const;

const resultKeys = [
  'capability',
  'checkedAt',
  'generation',
  'lastError',
  'localPort',
  'localUrl',
  'machineId',
  'projectId',
  'publicPort',
  'runTarget',
  'serverId',
  'startedAt',
  'state',
  'tailscaleIPv4',
  'tailscaleUrl',
  'worktreeId'
] as const;

const listResultKeys = [
  'capability',
  'checkedAt',
  'generation',
  'lastError',
  'machineId',
  'projectId',
  'servers',
  'worktreeId'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return hasOnlyKeys(value, keys) && keys.every((key) => key in value);
}

function isCanonicalText(value: unknown, maximumLength = 1024): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRunTarget(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}

function isWorktreeId(value: unknown): value is string {
  return typeof value === 'string' && /^wt_[a-f0-9]{24}$/.test(value);
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isIPv4(value: string) {
  const segments = value.split('.');
  return (
    segments.length === 4 &&
    segments.every((segment) => {
      if (!/^\d{1,3}$/.test(segment) || (segment.length > 1 && segment.startsWith('0'))) {
        return false;
      }
      const parsed = Number(segment);
      return parsed >= 0 && parsed <= 255;
    })
  );
}

export function isNormalizedAllowedHost(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 253 ||
    value !== value.trim().toLowerCase()
  ) {
    return false;
  }
  if (isIPv4(value)) {
    return true;
  }

  const hostname = value;
  if (!hostname || hostname.endsWith('.') || hostname.includes('..')) {
    return false;
  }
  const labels = hostname.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  );
}

export function normalizeAllowedHosts(hosts: readonly string[]) {
  if (!Array.isArray(hosts) || hosts.length > 16) {
    throw new Error('Allowed hosts must contain at most 16 entries.');
  }
  const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase()))].sort();
  if (!normalized.every(isNormalizedAllowedHost)) {
    throw new Error(
      'Allowed hosts must be normalized IPv4 or DNS host names without ports or paths.'
    );
  }
  return normalized;
}

export function isNormalizedAllowedHostList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 16 || !value.every(isNormalizedAllowedHost)) {
    return false;
  }
  return value.every((host, index) => index === 0 || value[index - 1] < host);
}

export function isConnectorDevServerOperation(
  value: unknown
): value is ConnectorDevServerOperation {
  return connectorDevServerOperations.some((operation) => operation === value);
}

export function isConnectorDevServerGrant(value: unknown): value is ConnectorDevServerCommandGrant {
  if (!isRecord(value)) {
    return false;
  }
  const commonIsValid =
    isCanonicalText(value.userId, 256) &&
    isMachineId(value.machineId) &&
    isCanonicalText(value.projectId, 1024) &&
    isWorktreeId(value.worktreeId) &&
    isGitSha(value.expectedHeadSha) &&
    isConnectorDevServerOperation(value.operation) &&
    isIsoDate(value.issuedAt) &&
    isIsoDate(value.expiresAt) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    typeof value.nonce === 'string' &&
    /^[A-Za-z0-9_-]{20,128}$/.test(value.nonce) &&
    typeof value.signature === 'string' &&
    /^[A-Za-z0-9_-]{86}$/.test(value.signature);
  if (!commonIsValid) {
    return false;
  }
  if (value.operation === 'list') {
    return hasExactlyKeys(value, listGrantKeys);
  }
  return (
    hasExactlyKeys(value, actionGrantKeys) &&
    isRunTarget(value.serverId) &&
    value.runTarget === value.serverId &&
    isNormalizedAllowedHostList(value.allowedHosts)
  );
}

export function isConnectorDevServerWireRequest(
  value: unknown
): value is ConnectorDevServerWireRequest {
  if (!isRecord(value) || !hasExactlyKeys(value, actionWireRequestKeys)) {
    return false;
  }
  return (
    isMachineId(value.machineId) &&
    isCanonicalText(value.projectId, 1024) &&
    isWorktreeId(value.worktreeId) &&
    isGitSha(value.expectedHeadSha) &&
    isRunTarget(value.serverId) &&
    value.runTarget === value.serverId &&
    isNormalizedAllowedHostList(value.allowedHosts) &&
    isConnectorDevServerGrant(value.grant)
  );
}

export function isConnectorDevServerListWireRequest(
  value: unknown
): value is ConnectorDevServerListWireRequest {
  if (!isRecord(value) || !hasExactlyKeys(value, listWireRequestKeys)) {
    return false;
  }
  return (
    isMachineId(value.machineId) &&
    isCanonicalText(value.projectId, 1024) &&
    isWorktreeId(value.worktreeId) &&
    isGitSha(value.expectedHeadSha) &&
    isConnectorDevServerGrant(value.grant) &&
    value.grant.operation === 'list'
  );
}

export function isConnectorDevServerResult(value: unknown): value is ConnectorDevServerResult {
  if (!isRecord(value) || !hasOnlyKeys(value, resultKeys)) {
    return false;
  }
  const stateIsValid =
    value.state === 'starting' ||
    value.state === 'running' ||
    value.state === 'stopping' ||
    value.state === 'stopped' ||
    value.state === 'error';
  const tailscaleUrlIsValid =
    value.state === 'running' ? isHttpUrl(value.tailscaleUrl) : value.tailscaleUrl === undefined;

  return (
    (value.capability === 'configured' || value.capability === 'unavailable') &&
    (value.capability !== 'unavailable' || value.state === 'stopped') &&
    (value.state !== 'running' || value.capability === 'configured') &&
    stateIsValid &&
    isIsoDate(value.checkedAt) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    isMachineId(value.machineId) &&
    isCanonicalText(value.projectId, 1024) &&
    isCanonicalText(value.worktreeId, 1024) &&
    isRunTarget(value.serverId) &&
    value.runTarget === value.serverId &&
    (value.lastError === undefined || typeof value.lastError === 'string') &&
    (value.localPort === undefined || isPort(value.localPort)) &&
    (value.publicPort === undefined || isPort(value.publicPort)) &&
    (value.localUrl === undefined || isHttpUrl(value.localUrl)) &&
    (value.startedAt === undefined || isIsoDate(value.startedAt)) &&
    (value.tailscaleIPv4 === undefined ||
      (typeof value.tailscaleIPv4 === 'string' && isIPv4(value.tailscaleIPv4))) &&
    tailscaleUrlIsValid
  );
}

export function isConnectorDevServerListResult(
  value: unknown
): value is ConnectorDevServerListResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, listResultKeys) ||
    ![
      'capability',
      'checkedAt',
      'generation',
      'machineId',
      'projectId',
      'servers',
      'worktreeId'
    ].every((key) => key in value)
  ) {
    return false;
  }
  if (
    (value.capability !== 'configured' && value.capability !== 'unavailable') ||
    (value.lastError !== undefined && typeof value.lastError !== 'string') ||
    !isIsoDate(value.checkedAt) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !isMachineId(value.machineId) ||
    !isCanonicalText(value.projectId, 1024) ||
    !isCanonicalText(value.worktreeId, 1024) ||
    !Array.isArray(value.servers) ||
    value.servers.length > 64
  ) {
    return false;
  }
  const servers = value.servers as unknown[];
  return servers.every((server, index) => {
    if (
      !isRecord(server) ||
      !hasExactlyKeys(server, ['capability', 'label', 'serverId']) ||
      !isRunTarget(server.serverId)
    ) {
      return false;
    }
    const previous = servers[index - 1];
    const isSorted =
      index === 0 ||
      (isRecord(previous) &&
        typeof previous.serverId === 'string' &&
        previous.serverId < server.serverId);
    return (
      (server.capability === 'configured' || server.capability === 'unavailable') &&
      isCanonicalText(server.label, 128) &&
      isSorted
    );
  });
}

export function connectorDevServerErrorResult(
  request: ConnectorDevServerTrustedRequest,
  generation: number,
  lastError: string,
  capability: DevServerCapability = 'configured'
): ConnectorDevServerResult {
  return {
    capability,
    checkedAt: new Date().toISOString(),
    generation,
    lastError,
    machineId: request.machineId,
    projectId: request.projectId,
    runTarget: request.runTarget,
    serverId: request.serverId,
    state: capability === 'unavailable' ? 'stopped' : 'error',
    worktreeId: request.worktreeId
  };
}

export function connectorDevServerListErrorResult(
  request: ConnectorDevServerListTrustedRequest,
  generation: number
): ConnectorDevServerListResult {
  return {
    capability: 'unavailable',
    checkedAt: new Date().toISOString(),
    generation,
    machineId: request.machineId,
    projectId: request.projectId,
    servers: [],
    lastError: 'Development-server inventory is unavailable.',
    worktreeId: request.worktreeId
  };
}
