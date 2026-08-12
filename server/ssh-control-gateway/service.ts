import { createHash } from 'node:crypto';

import { selectAuthorizedAccessRoute } from '../private-network/route-resolver';
import type {
  SshGatewayAuditEvidence,
  SshGatewayActor,
  SshGatewayExecutionResult,
  SshGatewayRequest,
  SshGatewaySafeResult,
  SshGatewayStatusResult,
  SshControlHandshake
} from './contracts';
import {
  SshGatewayError,
  type SshControlTransport,
  type SshCredentialResolver,
  type SshGatewayAuthorizationProvider,
  type SshGatewayOperationStore,
  type SshGatewayRouteSource,
  type SshGatewayTargetResolver
} from './contracts';

const maximumOutputBytes = 64 * 1024;

export class SshControlGatewayService {
  constructor(private readonly dependencies: {
    authorization: SshGatewayAuthorizationProvider;
    credentials: SshCredentialResolver;
    operations: SshGatewayOperationStore;
    routes: SshGatewayRouteSource;
    targets: SshGatewayTargetResolver;
    transport: SshControlTransport;
  }) {}

  async execute(
    actor: SshGatewayActor,
    request: SshGatewayRequest
  ): Promise<SshGatewayExecutionResult> {
    validateRequest(actor, request);
    const firstAuthorization = await this.dependencies.authorization.authorize({
      actor,
      environmentId: request.environmentId,
      operation: request.operation,
      phase: 'route_resolution'
    });
    assertAuthorizationBinding(actor, request, firstAuthorization);
    const target = await this.dependencies.targets.resolve(actor.ownerUserId, request.environmentId);
    if (target.environmentId !== request.environmentId ||
      target.targetIdentityRevision !== firstAuthorization.target.identityRevision) {
      throw new SshGatewayError('route_unavailable', 'The Environment identity is unresolved.');
    }
    const selected = await selectAuthorizedAccessRoute({
      authorization: firstAuthorization,
      loadCandidates: () => this.dependencies.routes.load(actor.ownerUserId)
    });
    if (selected.state !== 'ready') {
      throw new SshGatewayError(
        selected.reason === 'authorization_denied' ? 'authorization_denied' : 'route_unavailable',
        'No authorized private-network SSH route is ready.'
      );
    }
    if (selected.route.routeKind !== 'ssh_private_network' ||
      selected.route.credentialPurpose !== 'project_control_gateway_v1') {
      throw new SshGatewayError('route_unavailable', 'No authorized private-network SSH route is ready.');
    }
    const audit = auditEvidence(actor, request, firstAuthorization, selected.route.routeId, 'accepted');
    const fingerprint = requestFingerprint(actor, request, firstAuthorization);
    const reserved = await this.dependencies.operations.reserve({
      audit,
      fingerprint,
      operationId: request.operationId,
      ownerUserId: actor.ownerUserId,
      targetEnvironmentId: request.environmentId
    });
    if (reserved.replayed) {
      if (reserved.record.state === 'succeeded' && reserved.record.result) {
        return { audit: reserved.record.audit, replayed: true, result: reserved.record.result };
      }
      throw new SshGatewayError(
        reserved.record.state === 'reserved' ? 'operation_in_progress' : 'operation_conflict',
        'The operation is already recorded and will not be dispatched again.'
      );
    }

    let dispatchAttempted = false;
    try {
      const secondAuthorization = await this.dependencies.authorization.authorize({
        actor,
        environmentId: request.environmentId,
        operation: request.operation,
        phase: 'execution'
      });
      assertAuthorizationBinding(actor, request, secondAuthorization);
      const executionTarget = await this.dependencies.targets.resolve(
        actor.ownerUserId, request.environmentId
      );
      if (!sameTargetBinding(executionTarget, target)) {
        throw new SshGatewayError('route_unavailable', 'The Environment identity changed.');
      }
      const revalidated = await selectAuthorizedAccessRoute({
        authorization: secondAuthorization,
        explicitRouteId: selected.route.routeId,
        loadCandidates: () => this.dependencies.routes.load(actor.ownerUserId)
      });
      if (revalidated.state !== 'ready' ||
        revalidated.route.routeKind !== 'ssh_private_network' ||
        revalidated.route.credentialPurpose !== 'project_control_gateway_v1' ||
        revalidated.route.target.id !== request.environmentId) {
        throw new SshGatewayError('authorization_denied', 'Execution authorization no longer matches the route.');
      }
      const reference = revalidated.route.credentialReference;
      if (!reference) throw new SshGatewayError('credential_unavailable', 'SSH credential is unavailable.');
      assertAuthorizationStable(firstAuthorization, secondAuthorization);
      const verifiedHost = await this.dependencies.transport.verifyHost({
        route: revalidated.route,
        timeoutMs: 5_000
      });
      const credential = await this.resolveCredential(reference);
      const handshake = validateHandshake(await this.handshake(
        revalidated.route, credential, verifiedHost
      ), request.operation);
      const finalAuthorization = await this.dependencies.authorization.authorize({
        actor,
        environmentId: request.environmentId,
        operation: request.operation,
        phase: 'execution'
      });
      assertAuthorizationBinding(actor, request, finalAuthorization, 5_000);
      assertAuthorizationStable(secondAuthorization, finalAuthorization);
      const finalTarget = await this.dependencies.targets.resolve(
        actor.ownerUserId, request.environmentId
      );
      if (!sameTargetBinding(finalTarget, target)) {
        throw new SshGatewayError('route_unavailable', 'The Environment identity changed.');
      }
      const finalRoute = await selectAuthorizedAccessRoute({
        authorization: finalAuthorization,
        explicitRouteId: selected.route.routeId,
        loadCandidates: () => this.dependencies.routes.load(actor.ownerUserId)
      });
      if (finalRoute.state !== 'ready' ||
        !sameRouteBinding(finalRoute.route, revalidated.route)) {
        throw new SshGatewayError('route_unavailable', 'The SSH route changed before execution.');
      }
      assertAuthorizationBinding(actor, request, finalAuthorization, 1_000);
      await this.dependencies.operations.markDispatchAttempted({
        fingerprint,
        operationId: request.operationId,
        ownerUserId: actor.ownerUserId
      });
      dispatchAttempted = true;
      const startedAt = Date.now();
      const result = validateControlResponse(
        await this.run(finalRoute.route, credential, request, verifiedHost, handshake), request,
        finalRoute.route.targetIdentityRevision, startedAt
      );
      const completedAudit = auditEvidence(
        actor, request, finalAuthorization, selected.route.routeId, 'succeeded'
      );
      await this.dependencies.operations.complete({
        audit: completedAudit,
        fingerprint,
        operationId: request.operationId,
        ownerUserId: actor.ownerUserId,
        result,
        state: 'succeeded'
      });
      return { audit: completedAudit, replayed: false, result };
    } catch (error) {
      const failure = normalizeError(error);
      const state = dispatchAttempted && failure.code === 'cli_incompatible'
        ? 'incompatible'
        : dispatchAttempted && (failure.code === 'timeout' || failure.code === 'remote_failed')
          ? 'uncertain'
          : 'failed';
      const outcome = state === 'uncertain' ? 'uncertain' : 'failed';
      try {
        await this.dependencies.operations.complete({
          audit: auditEvidence(actor, request, firstAuthorization, selected.route.routeId, outcome),
          fingerprint,
          operationId: request.operationId,
          ownerUserId: actor.ownerUserId,
          state
        });
      } catch {
        // The durable non-terminal row remains a replay fence if completion cannot be recorded.
      }
      throw failure;
    }
  }

  private async resolveCredential(reference: string) {
    try {
      const credential = await this.dependencies.credentials.resolve(reference);
      if (!credential.privateKey.trim() || credential.privateKey.length > 64 * 1024 ||
        credential.purpose !== 'project_control_gateway_v1' ||
        (credential.certificate !== undefined && (!credential.certificate.trim() ||
          credential.certificate.length > 64 * 1024))) {
        throw new Error('invalid credential');
      }
      return credential;
    } catch {
      throw new SshGatewayError('credential_unavailable', 'SSH credential is unavailable.');
    }
  }

  private async run(
    route: Parameters<SshControlTransport['execute']>[0]['route'],
    credential: Parameters<SshControlTransport['execute']>[0]['credential'],
    request: SshGatewayRequest,
    verifiedHost: Parameters<SshControlTransport['execute']>[0]['verifiedHost'],
    handshake: SshControlHandshake
  ) {
    const execution = await this.dependencies.transport.execute({
      credential,
      handshake,
      request,
      route,
      timeoutMs: 30_000,
      verifiedHost
    });
    return validatedTransportOutput(execution);
  }

  private async handshake(
    route: Parameters<SshControlTransport['handshake']>[0]['route'],
    credential: Parameters<SshControlTransport['handshake']>[0]['credential'],
    verifiedHost: Parameters<SshControlTransport['handshake']>[0]['verifiedHost']
  ) {
    return validatedTransportOutput(await this.dependencies.transport.handshake({
      credential, route, timeoutMs: 10_000, verifiedHost
    }));
  }
}

function validatedTransportOutput(
  execution: Awaited<ReturnType<SshControlTransport['execute']>>
) {
  if (execution.timedOut) throw new SshGatewayError('timeout', 'SSH control operation timed out.');
  if (execution.exitCode !== 0) {
    throw new SshGatewayError('remote_failed', 'SSH control operation failed.');
  }
  if (Buffer.byteLength(execution.stdout) > maximumOutputBytes ||
    Buffer.byteLength(execution.stderr) > maximumOutputBytes) {
    throw new SshGatewayError('remote_failed', 'SSH control output exceeded its limit.');
  }
  return execution.stdout;
}

function validateRequest(actor: SshGatewayActor, request: SshGatewayRequest) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(request.environmentId) ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(request.operationId) ||
    !validOperationRequest(request) || !actor.id || !actor.ownerUserId) {
    throw new SshGatewayError('operation_conflict', 'SSH gateway request is invalid.');
  }
}

function validOperationRequest(request: SshGatewayRequest) {
  if (request.operation === 'status.v1') {
    return request.workspaceId === undefined && request.expectedCommit === undefined &&
      request.expectedManifestDigest === undefined && request.expectedGeneration === undefined &&
      request.mode === undefined;
  }
  const workspaceOperation = /^workspace-runtime\.(start|inspect|suspend|resume|stop|clean|reconcile)\.v1$/
    .test(request.operation);
  const generationRequired = request.operation !== 'workspace-runtime.start.v1';
  return workspaceOperation && isUuid(request.workspaceId) &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(request.expectedCommit ?? '') &&
    /^[0-9a-f]{64}$/.test(request.expectedManifestDigest ?? '') &&
    (request.mode === 'process' || request.mode === 'devcontainer') &&
    (generationRequired ? isUuid(request.expectedGeneration) : request.expectedGeneration === undefined);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateHandshake(value: string, operation: SshGatewayRequest['operation']): SshControlHandshake {
  const lines = value.trim().split('\n');
  if (lines.length !== 1) {
    throw new SshGatewayError('cli_incompatible', 'Remote Project CLI control protocol is incompatible.');
  }
  const handshake = strictObject(lines[0]!, [
    'cliVersion', 'operations', 'protocolVersion', 'schemaVersion', 'type'
  ]);
  if (handshake.type !== 'handshake' || handshake.schemaVersion !== 1 ||
    handshake.protocolVersion !== 1 || typeof handshake.cliVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(handshake.cliVersion) ||
    !Array.isArray(handshake.operations) || handshake.operations.length > 32 ||
    handshake.operations.some((operation) => typeof operation !== 'string' ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(operation)) ||
    new Set(handshake.operations).size !== handshake.operations.length ||
    !handshake.operations.includes(operation)) {
    throw new SshGatewayError('cli_incompatible', 'Remote Project CLI control protocol is incompatible.');
  }
  return { cliVersion: handshake.cliVersion, protocolVersion: 1 };
}

function validateControlResponse(
  value: string,
  request: SshGatewayRequest,
  targetIdentityRevision: string,
  startedAt: number
): SshGatewaySafeResult {
  if (request.operation === 'status.v1') {
    return validateStatusResponse(value, request, targetIdentityRevision, startedAt);
  }
  return validateWorkspaceRuntimeResponse(value, request, targetIdentityRevision, startedAt);
}

function validateStatusResponse(
  value: string,
  request: SshGatewayRequest,
  targetIdentityRevision: string,
  startedAt: number
): SshGatewayStatusResult {
  const lines = value.trim().split('\n');
  if (lines.length !== 1) {
    throw new SshGatewayError('cli_incompatible', 'Remote Project CLI control protocol is incompatible.');
  }
  const parsed = strictObject(lines[0]!, [
    'checkedAt', 'operation', 'operationId', 'schemaVersion', 'state',
    'targetIdentityRevision', 'type'
  ]);
  const checkedAt = typeof parsed.checkedAt === 'string' ? Date.parse(parsed.checkedAt) : NaN;
  if (parsed.schemaVersion !== 1 || parsed.operation !== 'status.v1' || parsed.state !== 'ready' ||
    parsed.type !== 'result' || parsed.operationId !== request.operationId ||
    parsed.targetIdentityRevision !== targetIdentityRevision ||
    !Number.isFinite(checkedAt) || checkedAt < startedAt - 30_000 ||
    checkedAt > Date.now() + 30_000) {
    throw new SshGatewayError('cli_incompatible', 'Remote Project CLI status response is incompatible.');
  }
  return parsed as unknown as SshGatewayStatusResult;
}

function validateWorkspaceRuntimeResponse(
  value: string,
  request: SshGatewayRequest,
  targetIdentityRevision: string,
  startedAt: number
): SshGatewaySafeResult {
  const lines = value.trim().split('\n');
  if (lines.length !== 1) throw incompatible();
  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(lines[0]!) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error();
    parsed = candidate as Record<string, unknown>;
  } catch {
    throw incompatible();
  }
  const allowed = new Set([
    'checkedAt', 'disposition', 'generation', 'manifestDigest', 'mode', 'operation',
    'operationId', 'schemaVersion', 'sourceHead', 'state', 'targetIdentityRevision',
    'type', 'workspaceId'
  ]);
  const required = [
    'checkedAt', 'manifestDigest', 'mode', 'operation', 'operationId', 'schemaVersion',
    'sourceHead', 'state', 'targetIdentityRevision', 'type', 'workspaceId'
  ];
  if (Object.keys(parsed).some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in parsed))) throw incompatible();
  const checkedAt = typeof parsed.checkedAt === 'string' ? Date.parse(parsed.checkedAt) : NaN;
  const states = new Set(['starting', 'running', 'suspending', 'suspended', 'resuming',
    'stopping', 'stopped', 'cleaning', 'stale', 'failed']);
  if (parsed.schemaVersion !== 1 || parsed.type !== 'result' ||
    parsed.operation !== request.operation || parsed.operationId !== request.operationId ||
    parsed.targetIdentityRevision !== targetIdentityRevision ||
    parsed.workspaceId !== request.workspaceId || parsed.sourceHead !== request.expectedCommit ||
    parsed.manifestDigest !== request.expectedManifestDigest || parsed.mode !== request.mode ||
    typeof parsed.state !== 'string' || !states.has(parsed.state) ||
    !Number.isFinite(checkedAt) || checkedAt < startedAt - 30_000 || checkedAt > Date.now() + 30_000 ||
    (parsed.generation !== undefined && !isUuid(parsed.generation)) ||
    (parsed.disposition !== undefined && !['created', 'reused', 'cleaned'].includes(String(parsed.disposition)))) {
    throw incompatible();
  }
  if (request.expectedGeneration !== undefined && parsed.generation !== request.expectedGeneration) {
    throw incompatible();
  }
  return parsed as unknown as SshGatewaySafeResult;
}

function incompatible(): SshGatewayError {
  return new SshGatewayError('cli_incompatible', 'Remote Project CLI control protocol is incompatible.');
}

function strictObject(value: string, keys: readonly string[]): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new SshGatewayError('cli_incompatible', 'Remote Project CLI returned invalid JSON.');
  }
}

function requestFingerprint(
  actor: SshGatewayActor,
  request: SshGatewayRequest,
  authorization: Awaited<ReturnType<SshGatewayAuthorizationProvider['authorize']>>
) {
  return createHash('sha256').update(JSON.stringify({
    actorId: actor.id,
    actorKind: actor.kind,
    capability: 'project_cli',
    environmentId: request.environmentId,
    gatewayId: authorization.gatewayId,
    operation: request.operation,
    expectedCommit: request.expectedCommit,
    expectedGeneration: request.expectedGeneration,
    expectedManifestDigest: request.expectedManifestDigest,
    mode: request.mode,
    ownerUserId: actor.ownerUserId,
    targetIdentityRevision: authorization.target.identityRevision,
    workspaceId: request.workspaceId
  })).digest('hex');
}

function auditEvidence(
  actor: SshGatewayActor,
  request: SshGatewayRequest,
  authorization: Awaited<ReturnType<SshGatewayAuthorizationProvider['authorize']>>,
  routeId: string,
  outcome: SshGatewayAuditEvidence['outcome']
): SshGatewayAuditEvidence {
  return {
    actorId: actor.id,
    actorKind: actor.kind,
    capability: 'project_cli',
    ...(outcome === 'accepted' ? {} : { completedAt: new Date().toISOString() }),
    operation: request.operation,
    operationId: request.operationId,
    outcome,
    gatewayId: authorization.gatewayId,
    routeClass: 'ssh_private_network',
    routeId,
    targetEnvironmentId: request.environmentId,
    targetIdentityRevision: authorization.target.identityRevision
  };
}

function assertAuthorizationStable(
  first: Awaited<ReturnType<SshGatewayAuthorizationProvider['authorize']>>,
  second: Awaited<ReturnType<SshGatewayAuthorizationProvider['authorize']>>
) {
  if (first.ownerUserId !== second.ownerUserId || first.gatewayId !== second.gatewayId ||
    first.capability !== second.capability || first.risk !== second.risk ||
    first.target.kind !== second.target.kind || first.target.id !== second.target.id ||
    first.target.identityRevision !== second.target.identityRevision) {
    throw new SshGatewayError('authorization_denied', 'Execution authorization changed.');
  }
}

function assertAuthorizationBinding(
  actor: SshGatewayActor,
  request: SshGatewayRequest,
  authorization: Awaited<ReturnType<SshGatewayAuthorizationProvider['authorize']>>,
  minimumValidityMs = 0
) {
  const expiresAt = Date.parse(authorization.expiresAt);
  if (!authorization.allowed || authorization.ownerUserId !== actor.ownerUserId ||
    authorization.capability !== 'project_cli' || authorization.target.kind !== 'environment' ||
    authorization.target.id !== request.environmentId ||
    !authorization.target.identityRevision || !authorization.gatewayId ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now() + minimumValidityMs) {
    throw new SshGatewayError('authorization_denied', 'The operation is not authorized.');
  }
}

function sameRouteBinding(
  left: Parameters<SshControlTransport['execute']>[0]['route'],
  right: Parameters<SshControlTransport['execute']>[0]['route']
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTargetBinding(
  left: Awaited<ReturnType<SshGatewayTargetResolver['resolve']>>,
  right: Awaited<ReturnType<SshGatewayTargetResolver['resolve']>>
) {
  return left.environmentId === right.environmentId &&
    left.environmentDefinitionId === right.environmentDefinitionId &&
    left.platformId === right.platformId && left.hostId === right.hostId &&
    left.targetIdentityRevision === right.targetIdentityRevision;
}

function normalizeError(error: unknown) {
  return error instanceof SshGatewayError
    ? error
    : new SshGatewayError('remote_failed', 'SSH control operation failed.');
}
