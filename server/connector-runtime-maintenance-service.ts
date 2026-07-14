import type {
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState,
  MachineRuntimeOperationResult,
  MachineRuntimeStatusResult
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  connectorRuntimeReleaseTarget,
  parseConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeMaintenanceOperation,
  type ConnectorRuntimeReleaseTarget
} from './connector-runtime-maintenance-contract';
import type {
  ConnectorRuntimeCommandFingerprint,
  ConnectorRuntimeCommandPlan
} from './connector-runtime-command-contract';
import type {
  ConnectorRuntimeAuditInput,
  ConnectorRuntimeOperationStore
} from './connector-runtime-operation-store';
import {
  ConnectorRuntimeReleaseManifestError,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type ConnectorRuntimeReleaseArtifact,
  type ConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';
import {
  compareConnectorRuntimeSemanticVersions,
  connectorRuntimeFingerprint,
  projectMachineRuntimeStatus,
  runtimeMatchesExpectedFingerprint,
  type ConnectorRuntimeApprovedRelease
} from './connector-runtime-status';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const updateTimeoutMs = 10 * 60_000;
const restartTimeoutMs = 2 * 60_000;
const activeStates: ConnectorRuntimeOperationState[] = [
  'queued', 'validating', 'staging', 'verified', 'switching', 'restarting',
  'reconnecting', 'health-checking', 'rolling-back'
];
const recoverableRollbackFailureCodes = new Set(['health-timeout', 'reconnect-timeout']);

export interface ConnectorRuntimeMachineMembership {
  role: 'member' | 'owner';
}

export interface ConnectorRuntimeMaintenanceDirectory {
  readMachine(machineId: string): Promise<MachineRecord | null>;
  readMembership(input: {
    machineId: string;
    userId: string;
  }): Promise<ConnectorRuntimeMachineMembership | null>;
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

export type ConnectorRuntimeMaintenanceProgress =
  | 'accepted'
  | 'staging'
  | 'validating'
  | 'verifying';

export interface ConnectorRuntimeMaintenanceDispatcher {
  dispatch(input: {
    onProgress(stage: ConnectorRuntimeMaintenanceProgress): void;
    plan: ConnectorRuntimeCommandPlan;
    userId: string;
  }): Promise<void>;
}

export type ConnectorRuntimeMaintenanceServiceErrorCode =
  | 'invalid-actor'
  | 'offline'
  | 'operation-conflict'
  | 'rate-limited'
  | 'release-downgrade'
  | 'unauthorized'
  | 'unknown-machine'
  | 'unsupported-operation'
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
  directory: ConnectorRuntimeMaintenanceDirectory;
  dispatcher: ConnectorRuntimeMaintenanceDispatcher;
  manifestPublicKey?: Parameters<typeof verifyConnectorRuntimeReleaseManifest>[1];
  now?(): Date;
  operations: ConnectorRuntimeOperationStore;
  rateLimiter: ConnectorRuntimeMaintenanceRateLimiter;
  releases: ConnectorRuntimeApprovedReleaseSource;
}

interface VerifiedRelease extends ConnectorRuntimeApprovedRelease {
  signed: SignedConnectorRuntimeReleaseManifest;
}

function targetForMachine(machine: MachineRecord): ConnectorRuntimeReleaseTarget | undefined {
  const runtime = machine.connector.runtime;
  return runtime && connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
}

function commandFingerprint(machine: MachineRecord): ConnectorRuntimeCommandFingerprint {
  const runtime = machine.connector.runtime!;
  return {
    buildId: runtime.buildId,
    bundleVersions: { ...runtime.bundleVersions },
    capabilities: [...new Set(machine.connector.capabilities ?? [])].sort(),
    instanceId: runtime.instanceId,
    protocolVersion: runtime.protocolVersion,
    releaseId: runtime.releaseId,
    version: runtime.version
  };
}

function expectedFingerprint(
  machine: MachineRecord,
  release?: { artifact: ConnectorRuntimeReleaseArtifact; manifest: ConnectorRuntimeReleaseManifest }
): ConnectorRuntimeFingerprint {
  const runtime = machine.connector.runtime!;
  return release
      ? {
        buildId: release.manifest.buildId,
        bundleVersions: { ...release.artifact.bundleVersions },
        capabilities: [...release.artifact.capabilities],
        instanceId: runtime.instanceId,
        protocolVersion: release.artifact.protocolVersion,
        releaseId: release.manifest.releaseId,
        version: release.manifest.version
      }
    : connectorRuntimeFingerprint(runtime, machine.connector.capabilities ?? []);
}

function runtimeMatchesRollbackFingerprint(
  machine: MachineRecord,
  operation: ConnectorRuntimeOperationRecord
) {
  const runtime = machine.connector.runtime;
  const previous = operation.previousFingerprint;
  if (!runtime || !previous || previous.instanceId !== operation.previousInstanceId ||
      !runtimeMatchesExpectedFingerprint(
        runtime,
        machine.connector.capabilities ?? [],
        previous,
        operation.previousInstanceId
      )) return false;
  const actual = connectorRuntimeFingerprint(
    runtime,
    machine.connector.capabilities ?? []
  );
  return actual.capabilities.length === previous.capabilities.length &&
    actual.capabilities.every((capability, index) => capability === previous.capabilities[index]);
}

function progressState(stage: ConnectorRuntimeMaintenanceProgress): ConnectorRuntimeOperationState {
  if (stage === 'staging') return 'staging';
  if (stage === 'verifying') return 'verified';
  if (stage === 'accepted') return 'restarting';
  return 'validating';
}

function reasonFor(error: unknown) {
  if (error instanceof ConnectorRuntimeMaintenanceServiceError ||
      error instanceof ConnectorRuntimeReleaseManifestError) return error.code;
  if (error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string') return error.code.slice(0, 128);
  return 'internal-error';
}

function dispatchFailure(error: unknown, now: string) {
  return {
    at: now,
    code: reasonFor(error),
    message: 'The connector could not start the requested maintenance operation.',
    rollbackAvailable: false
  };
}

export class ConnectorRuntimeMaintenanceService {
  private readonly now: () => Date;

  constructor(private readonly options: ConnectorRuntimeMaintenanceServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async status(machineId: string): Promise<MachineRuntimeStatusResult> {
    const machine = await this.options.directory.readMachine(machineId);
    if (!machine) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'unknown-machine', 'The selected machine is unavailable.'
      );
    }
    let operation = await this.options.operations.latest(machineId);
    operation = await this.reconcileDeadline(operation);
    const approved = await this.approvedRelease(machine).catch(() => undefined);
    return projectMachineRuntimeStatus({ approved, machine, operation });
  }

  async request(browserRequest: unknown, userId: string): Promise<MachineRuntimeOperationResult> {
    if (!identityPattern.test(userId)) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'invalid-actor', 'A valid authenticated user is required.'
      );
    }
    let request: ConnectorRuntimeMaintenanceBrowserRequest;
    try {
      request = parseConnectorRuntimeMaintenanceBrowserRequest(browserRequest);
    } catch (error) {
      await this.reject({ at: this.now().toISOString(), outcome: 'rejected',
        reason: reasonFor(error), userId });
      throw error;
    }

    try {
      return await this.authorizeAndStart(request, userId);
    } catch (error) {
      await this.reject({
        at: this.now().toISOString(), machineId: request.machineId,
        operation: request.operation, outcome: 'rejected', reason: reasonFor(error),
        releaseId: request.releaseId, userId
      });
      throw error;
    }
  }

  async decideReconnect(machine: MachineRecord) {
    const operation = await this.options.operations.latest(machine.id);
    const evidence = machine.connector.runtime?.maintenance;
    if (!operation || !evidence || evidence.operationId !== operation.id) return undefined;
    const now = this.now().toISOString();
    if (evidence.state === 'rolled-back') {
      if (!runtimeMatchesRollbackFingerprint(machine, operation)) return undefined;
      if (operation.state === 'rolled-back')
        return { action: 'rollback' as const, operationId: operation.id };
      const recoverableTerminalRollback = operation.operation === 'update' &&
        (operation.state === 'failed' || operation.state === 'recovery-required') &&
        operation.lastFailure?.rollbackAvailable === true &&
        recoverableRollbackFailureCodes.has(operation.lastFailure.code);
      if (recoverableTerminalRollback) {
        const recovered = await this.options.operations.transition({
          expectedStates: [operation.state], finishedAt: now, id: operation.id,
          state: 'rolled-back', updatedAt: now
        });
        return recovered ? { action: 'rollback' as const, operationId: operation.id } : undefined;
      }
      if (!activeStates.includes(operation.state) && operation.state !== 'succeeded') return;
      await this.options.operations.transition({
        expectedStates: [operation.state],
        ...(operation.state === 'rolling-back' || operation.state === 'succeeded'
          ? { finishedAt: now }
          : {}),
        id: operation.id,
        ...(operation.state === 'succeeded'
          ? { lastFailure: {
              at: now,
              code: 'supervisor-rollback-after-commit',
              message: 'The supervisor rolled back after the connector health decision.',
              rollbackAvailable: false
            } }
          : {}),
        state: operation.state === 'rolling-back' || operation.state === 'succeeded'
          ? 'rolled-back'
          : 'rolling-back',
        updatedAt: now
      });
      return { action: 'rollback' as const, operationId: operation.id };
    }
    if (operation.state === 'succeeded')
      return { action: 'commit' as const, operationId: operation.id };
    if (!activeStates.includes(operation.state)) return undefined;
    const runtime = machine.connector.runtime!;
    const matches = runtimeMatchesExpectedFingerprint(
      runtime,
      machine.connector.capabilities ?? [],
      operation.expectedFingerprint,
      operation.previousInstanceId
    );
    if (matches) {
      await this.options.operations.transition({
        expectedStates: [operation.state],
        ...(operation.state === 'health-checking' ? { finishedAt: now } : {}),
        id: operation.id,
        state: operation.state === 'health-checking' ? 'succeeded' : 'health-checking',
        updatedAt: now
      });
      return { action: 'commit' as const, operationId: operation.id };
    }
    await this.options.operations.transition({
      expectedStates: activeStates,
      id: operation.id,
      lastFailure: {
        at: now, code: 'wrong-reconnect-version',
        message: 'The connector reconnected with unexpected runtime evidence.',
        rollbackAvailable: operation.operation === 'update'
      },
      state: operation.operation === 'update' ? 'rolling-back' : 'failed',
      updatedAt: now
    });
    return { action: 'rollback' as const, operationId: operation.id };
  }

  private async authorizeAndStart(
    request: ConnectorRuntimeMaintenanceBrowserRequest,
    userId: string
  ) {
    const membership = await this.options.directory.readMembership({
      machineId: request.machineId, userId
    });
    if (membership?.role !== 'owner') {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'unauthorized', 'Only the machine owner can manage its connector runtime.'
      );
    }
    const machine = await this.options.directory.readMachine(request.machineId);
    if (!machine) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'unknown-machine', 'The selected machine is unavailable.'
      );
    }
    const runtime = machine.connector.runtime;
    if (machine.connector.status !== 'online' && machine.connector.status !== 'local') {
      throw new ConnectorRuntimeMaintenanceServiceError('offline', 'The connector is offline.');
    }
    const capability = `runtime.${request.operation}`;
    if (!runtime || runtime.source !== 'managed' ||
        !(machine.connector.capabilities ?? []).includes(capability)) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'unsupported-operation',
        'This connector cannot safely perform the requested managed operation.'
      );
    }
    const target = targetForMachine(machine);
    if (!target) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'unsupported-platform',
        'The selected machine platform does not support managed maintenance.'
      );
    }
    const requestedAt = this.now().toISOString();
    const rate = await this.options.rateLimiter.consume({
      machineId: request.machineId, operation: request.operation, requestedAt, userId
    });
    if (!rate.allowed) {
      throw new ConnectorRuntimeMaintenanceServiceError(
        'rate-limited', 'Connector runtime maintenance is temporarily rate limited.',
        rate.retryAfterMs
      );
    }
    const approved = request.operation === 'update'
      ? await this.approvedRelease(machine, request.releaseId, true)
      : undefined;
    if (approved) {
      const versionOrder = compareConnectorRuntimeSemanticVersions(
        runtime.version,
        approved.manifest.version
      );
      if (versionOrder === undefined) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'unsupported-operation',
          'The installed connector version cannot be compared safely.'
        );
      }
      if (versionOrder > 0) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'release-downgrade',
          'The approved connector release is older than the installed runtime.'
        );
      }
    }
    await this.reconcileDeadline(await this.options.operations.latest(request.machineId));
    const previous = connectorRuntimeFingerprint(runtime, machine.connector.capabilities ?? []);
    let operation: ConnectorRuntimeOperationRecord;
    try {
      operation = await this.options.operations.createAccepted({
        deadlineAt: new Date(Date.parse(requestedAt) +
          (request.operation === 'update' ? updateTimeoutMs : restartTimeoutMs)).toISOString(),
        expectedBuildId: approved?.manifest.buildId ?? runtime.buildId,
        expectedFingerprint: expectedFingerprint(machine, approved),
        expectedReleaseId: approved?.manifest.releaseId ?? runtime.releaseId,
        machineId: request.machineId,
        operation: request.operation,
        previousFingerprint: previous,
        previousInstanceId: runtime.instanceId,
        requestedByUserId: userId,
        requestedReleaseId: approved?.manifest.releaseId,
        target
      }, {
        at: requestedAt, machineId: request.machineId, operation: request.operation,
        outcome: 'accepted', releaseId: approved?.manifest.releaseId, userId
      }, requestedAt);
    } catch (error) {
      if (error && typeof error === 'object' &&
          (('code' in error && error.code === '23505') ||
            (error instanceof Error && error.message.includes('already active')))) {
        throw new ConnectorRuntimeMaintenanceServiceError(
          'operation-conflict',
          'Another connector runtime maintenance operation is already active.'
        );
      }
      throw error;
    }
    const plan = this.commandPlan(machine, operation.id, target, approved);
    this.dispatch(operation, plan, userId);
    return {
      operation,
      status: projectMachineRuntimeStatus({ approved, machine, operation })
    };
  }

  private commandPlan(
    machine: MachineRecord,
    operationId: string,
    target: ConnectorRuntimeReleaseTarget,
    approved?: VerifiedRelease
  ): ConnectorRuntimeCommandPlan {
    const base = {
      machineId: machine.id,
      operationId,
      previousRuntime: commandFingerprint(machine),
      schema: 'project-space.connector-runtime-command/v1' as const,
      target
    };
    return approved
      ? { ...base, operation: 'update', release: approved.signed,
          releaseId: approved.manifest.releaseId }
      : { ...base, operation: 'restart' };
  }

  private dispatch(
    operation: ConnectorRuntimeOperationRecord,
    plan: ConnectorRuntimeCommandPlan,
    userId: string
  ) {
    let transitions = Promise.resolve();
    const transition = (state: ConnectorRuntimeOperationState) => {
      transitions = transitions.then(async () => {
        const now = this.now().toISOString();
        await this.options.operations.transition({
          expectedStates: activeStates, id: operation.id,
          ...(state === 'validating' ? { startedAt: now } : {}), state, updatedAt: now
        });
      });
    };
    void this.options.dispatcher.dispatch({
      onProgress: (stage) => transition(progressState(stage)), plan, userId
    }).then(async () => {
      await transitions;
      transition('reconnecting');
      await transitions;
    }).catch(async (error) => {
      await transitions;
      const now = this.now().toISOString();
      await this.options.operations.transition({
        expectedStates: activeStates, finishedAt: now, id: operation.id,
        lastFailure: dispatchFailure(error, now), state: 'failed', updatedAt: now
      });
    });
  }

  private async approvedRelease(
    machine: MachineRecord,
    releaseId?: string,
    required = false
  ): Promise<VerifiedRelease | undefined> {
    const target = targetForMachine(machine);
    if (!target) return undefined;
    try {
      if (!this.options.manifestPublicKey) {
        throw new ConnectorRuntimeReleaseManifestError(
          'invalid-key', 'Connector runtime release verification is not configured.'
        );
      }
      const signed = await this.options.releases.loadApprovedManifest(releaseId);
      const manifest = verifyConnectorRuntimeReleaseManifest(
        signed, this.options.manifestPublicKey, { now: this.now().getTime() }
      );
      return {
        artifact: resolveConnectorRuntimeReleaseArtifact(manifest, target, releaseId),
        checkedAt: this.now().toISOString(), manifest,
        signed: structuredClone(signed) as SignedConnectorRuntimeReleaseManifest
      };
    } catch (error) {
      if (required) throw error;
      return undefined;
    }
  }

  private async reconcileDeadline(operation: ConnectorRuntimeOperationRecord | null) {
    if (!operation || !activeStates.includes(operation.state) ||
        !operation.deadlineAt || Date.parse(operation.deadlineAt) > this.now().getTime()) {
      return operation;
    }
    const now = this.now().toISOString();
    return await this.options.operations.transition({
      expectedStates: activeStates, finishedAt: now, id: operation.id,
      lastFailure: {
        at: now, code: 'reconnect-timeout',
        message: 'The connector did not return healthy before the operation timed out.',
        rollbackAvailable: operation.operation === 'update'
      },
      state: operation.operation === 'update' ? 'recovery-required' : 'failed',
      updatedAt: now
    }) ?? operation;
  }

  private async reject(audit: ConnectorRuntimeAuditInput) {
    await this.options.operations.recordRejection(audit).catch(() => undefined);
  }
}
