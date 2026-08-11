import type {
  DevServerConnectorResult,
  DevServerListConnectorResult,
  DevServerState,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';

export interface ConnectorExecutionRequest {
  allowedHosts: string[];
  expectedHeadSha: string;
  machineId: string;
  projectId: string;
  runTarget: string;
  serverId: string;
  worktreeId: string;
}

export interface ConnectorActor {
  generation: number;
  userId: string;
}

export interface ConnectorListExecutionRequest {
  expectedHeadSha: string;
  machineId: string;
  projectId: string;
  worktreeId: string;
}

const identifierPattern = /^[^\u0000-\u001f\u007f]+$/;
const runTargetPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const hostLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const allowedStates = new Set<DevServerState>([
  'error',
  'failed',
  'local-only',
  'running',
  'stale',
  'starting',
  'stopped',
  'stopping'
]);

export function requireIdentifier(value: unknown, label: string, maxLength = 512) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !identifierPattern.test(value)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function normalizeRunTarget(value: unknown) {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Invalid development-server run target.');
  }
  const target = typeof value === 'string' ? value.trim() || 'dev' : 'dev';
  if (!runTargetPattern.test(target)) {
    throw new Error('Invalid development-server run target.');
  }
  return target;
}

function isIPv4(value: string) {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) {
        return false;
      }
      const number = Number(part);
      return number >= 0 && number <= 255 && String(number) === part;
    })
  );
}

function isTailscaleIPv4(value: string) {
  if (!isIPv4(value)) {
    return false;
  }
  const [first, second] = value.split('.').map(Number);
  return first === 100 && second! >= 64 && second! <= 127;
}

function isValidHost(value: string) {
  if (value.length > 253 || /[:/\\,*?\s]/.test(value)) {
    return false;
  }
  if (isIPv4(value)) {
    return true;
  }
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => hostLabelPattern.test(label));
}

export function normalizeAllowedHosts(values: readonly string[]) {
  if (
    !Array.isArray(values) ||
    values.length > 16 ||
    !values.every((value) => typeof value === 'string')
  ) {
    throw new Error('Allowed hosts must contain at most 16 entries.');
  }
  const normalized = [
    ...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))
  ];
  if (!normalized.every(isValidHost)) {
    throw new Error(
      'Allowed hosts must be exact hostnames or IPv4 addresses without ports or paths.'
    );
  }
  return normalized.sort();
}

export function checkedAt(now: () => Date) {
  return now().toISOString();
}

function canonicalExposure(result: DevServerConnectorResult) {
  if (
    result.state !== 'running' ||
    !result.tailscaleIPv4 ||
    !isTailscaleIPv4(result.tailscaleIPv4) ||
    !Number.isSafeInteger(result.publicPort) ||
    !result.publicPort ||
    result.publicPort < 1 ||
    result.publicPort > 65_535 ||
    !result.tailscaleUrl
  ) {
    return undefined;
  }
  const canonical = `http://${result.tailscaleIPv4}:${result.publicPort}/`;
  try {
    const supplied = new URL(result.tailscaleUrl);
    if (
      supplied.toString() !== canonical ||
      supplied.username ||
      supplied.password ||
      supplied.search ||
      supplied.hash
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { tailscaleIPv4: result.tailscaleIPv4, tailscaleUrl: canonical };
}

function canonicalLocalUrl(result: DevServerConnectorResult) {
  if (
    !result.localUrl ||
    !Number.isSafeInteger(result.localPort) ||
    !result.localPort ||
    result.localPort < 1 ||
    result.localPort > 65_535
  ) {
    return undefined;
  }
  try {
    const supplied = new URL(result.localUrl);
    const direct = `http://127.0.0.1:${result.localPort}/`;
    if (supplied.toString() === direct) {
      return direct;
    }
    if (
      (supplied.protocol !== 'http:' && supplied.protocol !== 'https:') ||
      !supplied.hostname.endsWith('.localhost') ||
      !supplied.port ||
      supplied.pathname !== '/' ||
      supplied.username ||
      supplied.password ||
      supplied.search ||
      supplied.hash
    ) {
      return undefined;
    }
    return supplied.toString();
  } catch {
    return undefined;
  }
}

function validIsoDate(value: string | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

export function validateConnectorResult(
  result: DevServerConnectorResult,
  request: ConnectorExecutionRequest,
  actor: ConnectorActor,
  now: () => Date
) {
  const observedAt = Date.parse(result.checkedAt);
  const ageMs = now().getTime() - observedAt;
  if (
    result.machineId !== request.machineId ||
    result.projectId !== request.projectId ||
    result.worktreeId !== request.worktreeId ||
    result.runTarget !== request.runTarget ||
    result.serverId !== request.serverId ||
    result.generation !== actor.generation ||
    !allowedStates.has(result.state) ||
    (result.capability !== 'configured' && result.capability !== 'unavailable')
  ) {
    throw new Error('The connector returned a result for a different development-server request.');
  }
  if (!Number.isFinite(observedAt) || ageMs < -5_000 || ageMs > 30_000) {
    throw new Error('The connector returned stale development-server state.');
  }
  if (result.capability === 'unavailable' && result.state !== 'stopped') {
    throw new Error('The connector returned an invalid unavailable state.');
  }
  if (result.state === 'running' && result.capability !== 'configured') {
    throw new Error('The connector returned an invalid running state.');
  }
  if (result.state === 'local-only' && result.capability !== 'configured') {
    throw new Error('The connector returned an invalid local-only state.');
  }
  return result;
}

export function recordFromResult(
  result: DevServerConnectorResult,
  request: ConnectorExecutionRequest,
  now: () => Date,
  serverLabel = request.serverId
): WorktreeDevServerRecord {
  const exposure = canonicalExposure(result);
  const localUrl = canonicalLocalUrl(result);
  if (result.state === 'running' && !exposure) {
    throw new Error('The connector did not verify a canonical Tailscale TCP exposure.');
  }
  if (
    result.state === 'local-only' &&
    (result.publicPort !== undefined || result.tailscaleIPv4 || result.tailscaleUrl)
  ) {
    throw new Error('A local-only development server must not expose a Tailscale route.');
  }
  const observedAt = checkedAt(now);
  return {
    capability: result.capability,
    checkedAt: observedAt,
    lastError: ['error', 'failed', 'stale'].includes(result.state)
      ? 'Development server reported an error.'
      : undefined,
    localPort: result.localPort,
    localUrl,
    machineId: request.machineId,
    projectId: request.projectId,
    publicPort: exposure ? result.publicPort : undefined,
    runTarget: request.runTarget,
    serverId: request.serverId,
    serverLabel,
    startedAt: validIsoDate(result.startedAt),
    state: result.state,
    tailscaleIPv4: exposure?.tailscaleIPv4,
    tailscaleUrl: exposure?.tailscaleUrl,
    verifiedAt: exposure ? observedAt : undefined,
    worktreeId: request.worktreeId
  };
}

export function recordFromFailure(
  request: ConnectorExecutionRequest,
  _error: unknown,
  now: () => Date,
  serverLabel = request.serverId
): WorktreeDevServerRecord {
  return {
    capability: 'configured',
    checkedAt: checkedAt(now),
    lastError: 'Development server state could not be verified.',
    machineId: request.machineId,
    projectId: request.projectId,
    runTarget: request.runTarget,
    serverId: request.serverId,
    serverLabel,
    state: 'error',
    worktreeId: request.worktreeId
  };
}

export function validateConnectorListResult(
  result: DevServerListConnectorResult,
  request: ConnectorListExecutionRequest,
  actor: ConnectorActor,
  now: () => Date
) {
  const observedAt = Date.parse(result.checkedAt);
  const ageMs = now().getTime() - observedAt;
  if (
    result.machineId !== request.machineId ||
    result.projectId !== request.projectId ||
    result.worktreeId !== request.worktreeId ||
    result.generation !== actor.generation
  ) {
    throw new Error('The connector returned inventory for a different development-server request.');
  }
  if (!Number.isFinite(observedAt) || ageMs < -5_000 || ageMs > 30_000) {
    throw new Error('The connector returned stale development-server inventory.');
  }
  return result;
}
