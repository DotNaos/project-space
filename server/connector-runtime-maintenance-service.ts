import { randomUUID } from 'node:crypto';

import {
  connectorRuntimeReleaseTarget,
  parseConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeArchitecture,
  type ConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeMaintenanceOperation,
  type ConnectorRuntimeOperatingSystem,
  type ConnectorRuntimeReleaseTarget
} from './connector-runtime-maintenance-contract';
import {
  ConnectorRuntimeReleaseManifestError,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseArtifact,
  type ConnectorRuntimeReleaseChannel,
  type ConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';

const maintenancePlanSchema = 'project-space.connector-runtime-maintenance/v1' as const;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

export type ConnectorRuntimeMaintenanceState =
  | 'failed'
  | 'health-checking'
  | 'queued'
  | 'recovery-required'
  | 'restarting'
  | 'rolled-back'
  | 'rolling-back'
  | 'staging'
  | 'succeeded'
  | 'switching'
  | 'verifying'
  | 'waiting-for-reconnect';

export interface ConnectorRuntimeMachineFacts {
  architecture: ConnectorRuntimeArchitecture;
  operatingSystem: ConnectorRuntimeOperatingSystem;
}

export interface ConnectorRuntimeMachineMembership {
  role: 'member' | 'owner';
}

export interface ConnectorRuntimeMaintenanceOperationRecord {
  buildId?: string;
  id: string;
  machineId: string;
  operation: ConnectorRuntimeMaintenanceOperation;
  releaseId?: string;
  requestedAt: string;
  requestedByUserId: string;
  state: ConnectorRuntimeMaintenanceState;
  target: ConnectorRuntimeReleaseTarget;
  version?: string;
}

export interface ConnectorRuntimeMaintenanceAuditEvent {
  action: 'connector-runtime.maintenance-request';
  at: string;
  machineId?: string;
  operation?: ConnectorRuntimeMaintenanceOperation;
  operationId?: string;
  outcome: 'accepted' | 'rejected';
  reason?: string;
  releaseId?: string;
  userId: string;
}

interface ConnectorRuntimeMaintenancePlanBase {
  machineId: string;
  operationId: string;
  schema: typeof maintenancePlanSchema;
  target: ConnectorRuntimeReleaseTarget;
}

export interface ConnectorRuntimeRestartCommandPlan extends ConnectorRuntimeMaintenancePlanBase {
  operation: 'restart';
}

export interface ConnectorRuntimeUpdateCommandPlan extends ConnectorRuntimeMaintenancePlanBase {
  artifact: ConnectorRuntimeReleaseArtifact;
  buildId: string;
  channel: ConnectorRuntimeReleaseChannel;
  operation: 'update';
  releaseId: string;
  version: string;
}

export type ConnectorRuntimeMaintenanceCommandPlan =
  | ConnectorRuntimeRestartCommandPlan
  | ConnectorRuntimeUpdateCommandPlan;

export interface ConnectorRuntimeMaintenanceDirectory {
  readMachine(machineId: string): Promise<ConnectorRuntimeMachineFacts | null>;
  readMembership(input: {
    machineId: string;
    userId: string;
  }): Promise<ConnectorRuntimeMachineMembership | null>;
}

export interface ConnectorRuntimeMaintenanceOperationStore {
  createOperation(
    operation: ConnectorRuntimeMaintenanceOperationRecord,
    audit: ConnectorRuntimeMaintenanceAuditEvent
  ): Promise<boolean>;
}

export interface ConnectorRuntimeMaintenanceAuditLog {
  record(event: ConnectorRuntimeMaintenanceAuditEvent): Promise<void>;
}

export type ConnectorRuntimeMaintenanceRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface ConnectorRuntimeMaintenanceRateLimiter {
  consume(input: {
    machineId: string;
    operation: ConnectorRuntimeMaintenanceOperation;
    requestedAt: string;
    userId: string;
  }): Promise<ConnectorRuntimeMaintenanceRateLimitResult>;
}

export interface ConnectorRuntimeApprovedReleaseSource {
  loadApprovedManifest(releaseId?: string): Promise<unknown>;
}

export type ConnectorRuntimeMaintenanceServiceErrorCode =
  | 'invalid-actor'
  | 'operation-conflict'
  | 'rate-limited'
  | 'unauthorized'
  | 'unknown-machine'
  | 'unsupported-platform';

export class ConnectorRuntimeMaintenanceServiceError extends Error {
  constructor(
    readonly code: ConnectorRuntimeMaintenanceServiceErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ConnectorRuntimeMaintenanceServiceError';
  }
}

export interface ConnectorRuntimeMaintenanceServiceOptions {
  audit: ConnectorRuntimeMaintenanceAuditLog;
  createId?(): string;
  directory: ConnectorRuntimeMaintenanceDirectory;
  manifestPublicKey: Parameters<typeof verifyConnectorRuntimeReleaseManifest>[1];
  now?(): Date;
  operations: ConnectorRuntimeMaintenanceOperationStore;
  rateLimiter: ConnectorRuntimeMaintenanceRateLimiter;
  releases: ConnectorRuntimeApprovedReleaseSource;
}

function validActor(userId: string) {
  return identityPattern.test(userId);
}

function errorReason(error: unknown) {
  if (
    error instanceof ConnectorRuntimeMaintenanceServiceError ||
    error instanceof ConnectorRuntimeReleaseManifestError
  ) {
    return error.code;
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'invalid-request') {
    return 'invalid-request';
  }
  return 'internal-error';
}

export class ConnectorRuntimeMaintenanceService {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: ConnectorRuntimeMaintenanceServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async request(
    browserRequest: unknown,
    userId: string
  ): Promise<ConnectorRuntimeMaintenanceCommandPlan> {
    if (!validActor(userId)) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'invalid-actor',
        'A valid authenticated user is required.'
      );
    }

    let request: ConnectorRuntimeMaintenanceBrowserRequest;
    try {
      request = parseConnectorRuntimeMaintenanceBrowserRequest(browserRequest);
    } catch (error) {
      await this.recordRejection(userId, undefined, errorReason(error));
      throw error;
    }

    try {
      const membership = await this.options.directory.readMembership({
        machineId: request.machineId,
        userId
      });
      if (membership?.role !== 'owner') {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'unauthorized',
          'Only the machine owner can manage its connector runtime.'
        );
      }

      const requestedAt = this.now().toISOString();
      const rate = await this.options.rateLimiter.consume({
        machineId: request.machineId,
        operation: request.operation,
        requestedAt,
        userId
      });
      if (!rate.allowed) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'rate-limited',
          'Connector runtime maintenance is temporarily rate limited.',
          rate.retryAfterMs
        );
      }

      const machine = await this.options.directory.readMachine(request.machineId);
      if (!machine) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'unknown-machine',
          'The selected machine is unavailable.'
        );
      }
      const target = connectorRuntimeReleaseTarget(
        machine.operatingSystem,
        machine.architecture
      );
      if (!target) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'unsupported-platform',
          'The selected machine platform does not support managed maintenance.'
        );
      }

      const operationId = this.createId();
      const plan = await this.buildPlan(request, target, operationId);
      const operation = operationForPlan(plan, userId, requestedAt);
      const audit = auditForOperation(operation, 'accepted');
      if (!(await this.options.operations.createOperation(operation, audit))) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'operation-conflict',
          'Another connector runtime maintenance operation is already active.'
        );
      }
      return plan;
    } catch (error) {
      await this.recordRejection(userId, request, errorReason(error));
      throw error;
    }
  }

  private async buildPlan(
    request: ConnectorRuntimeMaintenanceBrowserRequest,
    target: ConnectorRuntimeReleaseTarget,
    operationId: string
  ): Promise<ConnectorRuntimeMaintenanceCommandPlan> {
    const base = {
      machineId: request.machineId,
      operationId,
      schema: maintenancePlanSchema,
      target
    };
    if (request.operation === 'restart') {
      return { ...base, operation: 'restart' };
    }

    const signedManifest = await this.options.releases.loadApprovedManifest(request.releaseId);
    const manifest = verifyConnectorRuntimeReleaseManifest(
      signedManifest,
      this.options.manifestPublicKey,
      { now: this.now().getTime() }
    );
    const artifact = resolveConnectorRuntimeReleaseArtifact(
      manifest,
      target,
      request.releaseId
    );
    return updatePlan(base, manifest, artifact);
  }

  private async recordRejection(
    userId: string,
    request: ConnectorRuntimeMaintenanceBrowserRequest | undefined,
    reason: string
  ) {
    await this.options.audit.record({
      action: 'connector-runtime.maintenance-request',
      at: this.now().toISOString(),
      machineId: request?.machineId,
      operation: request?.operation,
      outcome: 'rejected',
      reason,
      releaseId: request?.releaseId,
      userId
    });
  }
}

function updatePlan(
  base: ConnectorRuntimeMaintenancePlanBase,
  manifest: ConnectorRuntimeReleaseManifest,
  artifact: ConnectorRuntimeReleaseArtifact
): ConnectorRuntimeUpdateCommandPlan {
  return {
    ...base,
    artifact,
    buildId: manifest.buildId,
    channel: manifest.channel,
    operation: 'update',
    releaseId: manifest.releaseId,
    version: manifest.version
  };
}

function operationForPlan(
  plan: ConnectorRuntimeMaintenanceCommandPlan,
  userId: string,
  requestedAt: string
): ConnectorRuntimeMaintenanceOperationRecord {
  const base = {
    id: plan.operationId,
    machineId: plan.machineId,
    operation: plan.operation,
    requestedAt,
    requestedByUserId: userId,
    state: 'queued' as const,
    target: plan.target
  };
  return plan.operation === 'update'
    ? {
        ...base,
        buildId: plan.buildId,
        releaseId: plan.releaseId,
        version: plan.version
      }
    : base;
}

function auditForOperation(
  operation: ConnectorRuntimeMaintenanceOperationRecord,
  outcome: ConnectorRuntimeMaintenanceAuditEvent['outcome']
): ConnectorRuntimeMaintenanceAuditEvent {
  return {
    action: 'connector-runtime.maintenance-request',
    at: operation.requestedAt,
    machineId: operation.machineId,
    operation: operation.operation,
    operationId: operation.id,
    outcome,
    releaseId: operation.releaseId,
    userId: operation.requestedByUserId
  };
}
