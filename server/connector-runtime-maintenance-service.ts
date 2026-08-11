import type {
  ConnectorRuntimeOperationRecord,
  MachineRuntimeOperationResult,
  MachineRuntimeStatusResult
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  connectorCodexRuntimeIsReady
} from './connector-runtime-maintenance-health';
import {
  connectorRuntimeReleaseTarget,
  parseConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeMaintenanceBrowserRequest,
  type ConnectorRuntimeMaintenanceOperation,
  type ConnectorRuntimeReleaseTarget
} from './connector-runtime-maintenance-contract';
import type { ConnectorRuntimeCommandPlan } from './connector-runtime-command-contract';
import type {
  ConnectorRuntimeAuditInput,
  ConnectorRuntimeOperationStore
} from './connector-runtime-operation-store';
import {
  ConnectorRuntimeReleaseManifestError,
  resolveConnectorRuntimeReleaseArtifact,
  verifyConnectorRuntimeReleaseManifest,
  type SignedConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';
import {
  compareConnectorRuntimeSemanticVersions,
  connectorRuntimeFingerprint,
  projectMachineRuntimeStatus
} from './connector-runtime-status';
import { connectorRuntimeBridgeReleaseId } from './connector-runtime-release-source';
import {
  connectorRuntimeAutomaticUpdateActor,
  connectorRuntimeExpectedFingerprint,
  connectorRuntimeUpdateTimeoutMs,
  connectorRuntimeUpdateMatchesApproved,
  ensureConnectorRuntimeUpdatePending,
  type ConnectorRuntimeVerifiedRelease
} from './connector-runtime-auto-update';
import {
  activeConnectorRuntimeOperationStates as activeStates,
  runtimeMatchesOperationFingerprint,
  runtimeMatchesRollbackFingerprint
} from './connector-runtime-reconnect';
import { dispatchConnectorRuntimeOperation } from './connector-runtime-operation-dispatch';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const restartTimeoutMs = 2 * 60_000;
const recoverableRollbackFailureCodes = new Set(['health-timeout', 'reconnect-timeout']);

export interface ConnectorRuntimeMachineMembership {
  role: 'member' | 'owner';
}

export interface ConnectorRuntimeMaintenanceDirectory {
  canAutomaticallyUpdate?(machineId: string, ownerUserId?: string): Promise<boolean>;
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

function targetForMachine(machine: MachineRecord): ConnectorRuntimeReleaseTarget | undefined {
  const runtime = machine.connector.runtime;
  return runtime && connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
}

export function connectorRuntimeBridgeReleaseForMachine(machine: MachineRecord) {
  const runtime = machine.connector.runtime;
  if (!runtime || runtime.source !== 'managed' ||
      runtime.platform !== 'linux' || runtime.architecture !== 'x64') return undefined;
  const comparison = compareConnectorRuntimeSemanticVersions(runtime.version, '0.4.14');
  return comparison === -1 ? connectorRuntimeBridgeReleaseId : undefined;
}

function reasonFor(error: unknown) {
  if (error instanceof ConnectorRuntimeMaintenanceServiceError ||
      error instanceof ConnectorRuntimeReleaseManifestError) return error.code;
  if (error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string') return error.code.slice(0, 128);
  return 'internal-error';
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
    return this.statusForMachine(machine);
  }

  async statusForMachine(machine: MachineRecord): Promise<MachineRuntimeStatusResult> {
    let operation = await this.options.operations.latest(machine.id);
    operation = await this.reconcileDeadline(operation);
    const approved = await this.approvedRelease(
      machine,
      connectorRuntimeBridgeReleaseForMachine(machine)
    ).catch(() => undefined);
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
    if (!evidence) {
      if (await this.reconcileMissingMaintenanceEvidence(machine, operation)) return undefined;
      await this.prepareReconnect(machine);
      return undefined;
    }
    if (!operation || evidence.operationId !== operation.id) return undefined;
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
      const rolledBack = await this.options.operations.transition({
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
      return rolledBack
        ? { action: 'rollback' as const, operationId: operation.id }
        : this.freshReconnectDecision(machine, operation.id, 'rollback');
    }
    const matches = runtimeMatchesOperationFingerprint(machine, operation);
    if (matches) {
      if (!connectorCodexRuntimeIsReady(machine, operation)) {
        if (!activeStates.includes(operation.state) && operation.state !== 'succeeded') return;
        const rejected = await this.options.operations.transition({
          expectedStates: [operation.state],
          id: operation.id,
          lastFailure: {
            at: now,
            code: 'codex-runtime-not-ready',
            message: 'The connector updated, but its managed Codex runtime did not prove compatibility.',
            rollbackAvailable: operation.operation === 'update'
          },
          state: operation.operation === 'update' ? 'rolling-back' : 'failed',
          updatedAt: now
        });
        return rejected && operation.operation === 'update'
          ? { action: 'rollback' as const, operationId: operation.id }
          : undefined;
      }
      if (operation.state === 'succeeded')
        return { action: 'commit' as const, operationId: operation.id };
      if (!activeStates.includes(operation.state)) return undefined;
      const succeeded = await this.options.operations.transition({
        expectedStates: [operation.state],
        finishedAt: now,
        id: operation.id,
        lastFailure: null,
        state: 'succeeded',
        updatedAt: now
      });
      return succeeded
        ? { action: 'commit' as const, operationId: operation.id }
        : this.freshReconnectDecision(machine, operation.id, 'commit');
    }
    if (!activeStates.includes(operation.state) && operation.state !== 'succeeded') return undefined;
    const rejected = await this.options.operations.transition({
      expectedStates: [operation.state],
      id: operation.id,
      lastFailure: {
        at: now, code: 'wrong-reconnect-version',
        message: 'The connector reconnected with unexpected runtime evidence.',
        rollbackAvailable: operation.operation === 'update'
      },
      state: operation.operation === 'update' ? 'rolling-back' : 'failed',
      updatedAt: now
    });
    return rejected && operation.operation === 'update'
      ? { action: 'rollback' as const, operationId: operation.id }
      : rejected ? undefined : this.freshReconnectDecision(machine, operation.id, 'rollback');
  }

  private async freshReconnectDecision(
    machine: MachineRecord,
    operationId: string,
    action: 'commit' | 'rollback'
  ) {
    const fresh = await this.options.operations.latest(machine.id);
    if (!fresh || fresh.id !== operationId) return undefined;
    if (action === 'commit' && fresh.state === 'succeeded' &&
        runtimeMatchesOperationFingerprint(machine, fresh) &&
        connectorCodexRuntimeIsReady(machine, fresh)) {
      return { action, operationId } as const;
    }
    if (action === 'rollback' &&
        (fresh.state === 'rolling-back' || fresh.state === 'rolled-back')) {
      return { action, operationId } as const;
    }
    return undefined;
  }

  private async reconcileMissingMaintenanceEvidence(
    machine: MachineRecord,
    operation: ConnectorRuntimeOperationRecord | null
  ) {
    const reconciled = await this.reconcileDeadline(operation);
    if (!reconciled || !activeStates.includes(reconciled.state) ||
        reconciled.state === 'queued') return false;
    if (machine.connector.runtime?.instanceId === reconciled.previousInstanceId) return false;
    const at = this.now().toISOString();
    await this.options.operations.transition({
      expectedStates: [reconciled.state], finishedAt: at, id: reconciled.id,
      lastFailure: {
        at,
        code: 'maintenance-evidence-missing',
        message: 'The connector returned without evidence for the dispatched maintenance.',
        rollbackAvailable: reconciled.operation === 'update'
      },
      state: reconciled.operation === 'update' ? 'recovery-required' : 'failed',
      updatedAt: at
    });
    return true;
  }

  async prepareReconnect(machine: MachineRecord, ownerUserId?: string) {
    const operation = await this.options.operations.latest(machine.id);
    if (!machine.connector.runtime?.maintenance &&
        !await this.reconcileMissingMaintenanceEvidence(machine, operation)) {
      await this.ensureAutomaticUpdate(machine, ownerUserId);
    }
  }

  async continueMaintenance(machine: MachineRecord, ownerUserId?: string) {
    await this.reconcileDeadline(await this.options.operations.latest(machine.id));
    const pending = await this.ensureAutomaticUpdate(machine, ownerUserId);
    if (!pending) return;
    const target = targetForMachine(machine);
    if (!target) return;
    await this.startQueuedOperation(
      machine,
      pending.operation,
      target,
      pending.approved,
      pending.operation.requestedByUserId,
      ownerUserId
    );
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
          (request.operation === 'update'
            ? connectorRuntimeUpdateTimeoutMs
            : restartTimeoutMs)).toISOString(),
        expectedBuildId: approved?.manifest.buildId ?? runtime.buildId,
        expectedFingerprint: approved
          ? connectorRuntimeExpectedFingerprint(machine, approved)
          : previous,
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
    await this.startQueuedOperation(machine, operation, target, approved, userId);
    return {
      operation,
      status: projectMachineRuntimeStatus({ approved, machine, operation })
    };
  }

  private async ensureAutomaticUpdate(machine: MachineRecord, ownerUserId?: string) {
    const approved = await this.approvedRelease(
      machine,
      connectorRuntimeBridgeReleaseForMachine(machine)
    ).catch(() => undefined);
    let pending = await ensureConnectorRuntimeUpdatePending({
      approved,
      machine,
      now: this.now(),
      operations: this.options.operations
    });
    if (!pending) {
      const latest = await this.options.operations.latest(machine.id);
      if (latest?.operation === 'update' && latest.state === 'queued' &&
          latest.expectedReleaseId &&
          latest.expectedReleaseId !== approved?.manifest.releaseId) {
        let pinned: ConnectorRuntimeVerifiedRelease | undefined;
        try {
          pinned = await this.approvedRelease(machine, latest.expectedReleaseId, true);
        } catch (error) {
          const verifiedFailure = error instanceof ConnectorRuntimeReleaseManifestError;
          await this.blockQueuedUpdate(
            latest,
            verifiedFailure ? error.code : 'unavailable',
            verifiedFailure
              ? 'Update blocked because its persisted release no longer verifies.'
              : 'Update deferred until its persisted signed release is available again.'
          );
          return undefined;
        }
        pending = await ensureConnectorRuntimeUpdatePending({
          approved: pinned, machine, now: this.now(), operations: this.options.operations
        });
        if (!pending) await this.blockQueuedUpdate(
          latest,
          'persisted-release-mismatch',
          'Update blocked because its signed persisted release target cannot be reconstructed.'
        );
      }
    }
    if (!pending) return undefined;
    if (!await this.automaticUpdateAllowed(machine.id, ownerUserId)) {
      await this.blockQueuedUpdate(
        pending.operation,
        'ambiguous-physical-machine',
        'Update blocked until one canonical live connector identifies this machine.'
      );
      return undefined;
    }
    return pending;
  }

  private async startQueuedOperation(
    machine: MachineRecord,
    operation: ConnectorRuntimeOperationRecord,
    target: ConnectorRuntimeReleaseTarget,
    approved: ConnectorRuntimeVerifiedRelease | undefined,
    userId: string,
    ownerUserId?: string
  ) {
    if (operation.requestedByUserId === connectorRuntimeAutomaticUpdateActor &&
        !await this.automaticUpdateAllowed(machine.id, ownerUserId)) {
      await this.blockQueuedUpdate(
        operation,
        'ambiguous-physical-machine',
        'Update blocked because the connector is no longer the canonical live machine target.'
      );
      return;
    }
    if (!operation.previousFingerprint ||
        (operation.operation === 'update' &&
          (!approved || !connectorRuntimeUpdateMatchesApproved(operation, approved)))) {
      await this.blockQueuedUpdate(
        operation,
        'persisted-release-mismatch',
        'Update blocked because its signed manifest does not match the persisted target.'
      );
      return;
    }
    const startedAt = this.now().toISOString();
    const claimed = await this.options.operations.claimQueued({
      deadlineAt: new Date(Date.parse(startedAt) +
        (operation.operation === 'update'
          ? connectorRuntimeUpdateTimeoutMs
          : restartTimeoutMs)).toISOString(),
      expectedBuildId: operation.expectedBuildId,
      expectedFingerprint: operation.expectedFingerprint,
      expectedReleaseId: operation.expectedReleaseId,
      id: operation.id,
      requestedReleaseId: approved?.manifest.releaseId,
      startedAt,
      target,
      updatedAt: startedAt
    });
    if (!claimed) return;
    dispatchConnectorRuntimeOperation({
      dispatcher: this.options.dispatcher,
      now: this.now,
      operation: claimed,
      operations: this.options.operations,
      plan: this.commandPlan(machine, claimed, target, approved),
      userId
    });
  }

  private commandPlan(
    machine: MachineRecord,
    operation: ConnectorRuntimeOperationRecord,
    target: ConnectorRuntimeReleaseTarget,
    approved?: ConnectorRuntimeVerifiedRelease
  ): ConnectorRuntimeCommandPlan {
    const base = {
      machineId: machine.id,
      operationId: operation.id,
      previousRuntime: { ...operation.previousFingerprint! },
      schema: 'project-space.connector-runtime-command/v1' as const,
      target
    };
    return approved
      ? { ...base, operation: 'update', release: approved.signed,
          releaseId: approved.manifest.releaseId }
      : { ...base, operation: 'restart' };
  }

  private async automaticUpdateAllowed(machineId: string, ownerUserId?: string) {
    if (!this.options.directory.canAutomaticallyUpdate) return true;
    return await this.options.directory.canAutomaticallyUpdate(machineId, ownerUserId)
      .catch(() => false);
  }

  private async blockQueuedUpdate(
    operation: ConnectorRuntimeOperationRecord,
    code: string,
    message: string
  ) {
    const now = this.now().toISOString();
    await this.options.operations.transition({
      expectedStates: ['queued'], id: operation.id,
      lastFailure: { at: now, code, message, rollbackAvailable: false },
      state: 'queued', updatedAt: now
    });
  }

  private async approvedRelease(
    machine: MachineRecord,
    releaseId?: string,
    required = false
  ): Promise<ConnectorRuntimeVerifiedRelease | undefined> {
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
    if (!operation || operation.state === 'queued' || !activeStates.includes(operation.state) ||
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
