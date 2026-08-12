import type { SshGatewayActor, SshGatewayRequest } from './contracts';
import { SshGatewayError } from './contracts';

export function validateRequest(actor: SshGatewayActor, request: SshGatewayRequest) {
  if (!isUuid(request.environmentId) ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(request.operationId) ||
    !validOperationRequest(request) || !actor.id || !actor.ownerUserId) {
    throw new SshGatewayError('operation_conflict', 'SSH gateway request is invalid.');
  }
}

export function validateReplayRequest(actor: SshGatewayActor, request: SshGatewayRequest) {
  if (request.operation === 'worktree.prepare.v1') {
    if (!validWorktreePrepare(request) || !actor.id || !actor.ownerUserId) {
      throw new SshGatewayError('operation_conflict', 'SSH gateway replay request is invalid.');
    }
    return;
  }
  const validStart = request.operation === 'workspace-runtime.start.v1' &&
    isUuid(request.environmentId) && isUuid(request.workspaceId) && isUuid(request.expectedGeneration) &&
    /^[A-Za-z0-9:._-]{1,256}$/.test(request.operationId) &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(request.expectedCommit ?? '') &&
    /^[0-9a-f]{64}$/.test(request.expectedManifestDigest ?? '') &&
    validRuntimeAuthority(request) &&
    (request.mode === 'process' || request.mode === 'devcontainer') &&
    !runtimeSessionValuesPresent(request) && actor.id !== '' && actor.ownerUserId !== '';
  if (!validStart) {
    throw new SshGatewayError('operation_conflict', 'SSH gateway replay request is invalid.');
  }
}

function validRuntimeAuthority(request: SshGatewayRequest) {
  return /^[^\u0000-\u001f\u007f]{1,256}$/.test(request.expectedBranch ?? '') &&
    /^[A-Za-z0-9._+-]{1,64}$/.test(request.expectedRuntimeVersion ?? '');
}

function validOperationRequest(request: SshGatewayRequest) {
  if (request.operation === 'worktree.prepare.v1') return validWorktreePrepare(request);
  if (request.operation === 'status.v1') {
    return request.workspaceId === undefined && request.expectedCommit === undefined &&
      request.expectedManifestDigest === undefined && request.expectedGeneration === undefined &&
      request.expectedBranch === undefined && request.expectedRuntimeVersion === undefined &&
      request.mode === undefined && !runtimeSessionValuesPresent(request);
  }
  const workspaceOperation = /^workspace-runtime\.(start|inspect|suspend|resume|stop|clean|reconcile)\.v1$/
    .test(request.operation);
  const start = request.operation === 'workspace-runtime.start.v1';
  const runtimeSession = runtimeSessionValuesPresent(request);
  return workspaceOperation && isUuid(request.workspaceId) &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(request.expectedCommit ?? '') &&
    /^[0-9a-f]{64}$/.test(request.expectedManifestDigest ?? '') &&
    (request.mode === 'process' || request.mode === 'devcontainer') &&
    (start
      ? runtimeSession
        ? isUuid(request.expectedGeneration) && validRuntimeAuthority(request) &&
          validRuntimeSessionRequest(request)
        : request.expectedGeneration === undefined && !runtimeAuthorityPresent(request)
      : isUuid(request.expectedGeneration) && !runtimeSession && !runtimeAuthorityPresent(request));
}

function validWorktreePrepare(request: SshGatewayRequest) {
  return isUuid(request.workspaceId) && isUuid(request.worktreeOwnerThreadId) &&
    /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(request.repository ?? '') &&
    /^[^\u0000-\u001f\u007f]{1,255}$/.test(request.branch ?? '') &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(request.commit ?? '') &&
    request.expectedBranch === undefined && request.expectedCommit === undefined &&
    request.expectedGeneration === undefined && request.expectedManifestDigest === undefined &&
    request.expectedRuntimeVersion === undefined && request.mode === undefined &&
    !runtimeSessionValuesPresent(request);
}

function runtimeAuthorityPresent(request: SshGatewayRequest) {
  return request.expectedBranch !== undefined || request.expectedRuntimeVersion !== undefined;
}

function runtimeSessionValuesPresent(request: SshGatewayRequest) {
  return request.runtimeSessionEndpoint !== undefined || request.runtimeSessionToken !== undefined ||
    request.runtimeSessionExpiresAt !== undefined || request.runtimeSessionVersion !== undefined ||
    request.runtimeSessionCapabilities !== undefined;
}

function validRuntimeSessionRequest(request: SshGatewayRequest) {
  let endpoint: URL;
  try {
    endpoint = new URL(request.runtimeSessionEndpoint ?? '');
  } catch {
    return false;
  }
  const expiresAt = Date.parse(request.runtimeSessionExpiresAt ?? '');
  const capabilities = request.runtimeSessionCapabilities;
  const allowed = new Set([
    'runtime.lifecycle', 'runtime.heartbeat', 'runtime.dev-servers',
    'runtime.telemetry', 'runtime.log-pointers'
  ]);
  const requested = request.runtimeSessionRequestedCapabilities ?? [];
  const mutation = requested.includes('runtime.mutation.v1');
  const requestedAllowed = new Set(['runtime.codex.v1', 'runtime.control.v1', 'runtime.mutation.v1']);
  return endpoint.protocol === 'wss:' && endpoint.pathname === '/api/workspace-runtimes/socket' &&
    endpoint.username === '' && endpoint.password === '' && endpoint.search === '' && endpoint.hash === '' &&
    /^[A-Za-z0-9_-]{43}$/.test(request.runtimeSessionToken ?? '') &&
    /^[A-Za-z0-9._+-]{1,64}$/.test(request.runtimeSessionVersion ?? '') &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 60 * 60_000 &&
    Array.isArray(capabilities) && capabilities.length >= 2 && capabilities.length <= allowed.size &&
    new Set(capabilities).size === capabilities.length && capabilities.every((value) => allowed.has(value)) &&
    capabilities.includes('runtime.lifecycle') && capabilities.includes('runtime.heartbeat') &&
    requested.length >= 1 && requested.length <= requestedAllowed.size &&
    new Set(requested).size === requested.length && requested.every((value) => requestedAllowed.has(value)) &&
    (!mutation || requested.includes('runtime.control.v1') && isUuid(request.worktreeOwnerThreadId)) &&
    (mutation || request.worktreeOwnerThreadId === undefined);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
