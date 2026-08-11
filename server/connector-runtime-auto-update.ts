import type {
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationRecord
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import { connectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';
import type { ConnectorRuntimeOperationStore } from './connector-runtime-operation-store';
import { connectorCodexRuntimeMatchesExpected } from './connector-runtime-maintenance-health';
import type { SignedConnectorRuntimeReleaseManifest } from './connector-runtime-release-manifest';
import {
  compareConnectorRuntimeSemanticVersions,
  connectorRuntimeFingerprint,
  type ConnectorRuntimeApprovedRelease
} from './connector-runtime-status';

export const connectorRuntimeAutomaticUpdateActor = 'system:connector-auto-update';
export const connectorRuntimeUpdateTimeoutMs = 10 * 60_000;

export interface ConnectorRuntimeVerifiedRelease extends ConnectorRuntimeApprovedRelease {
  signed: SignedConnectorRuntimeReleaseManifest;
}

export interface PendingConnectorRuntimeUpdate {
  approved: ConnectorRuntimeVerifiedRelease;
  operation: ConnectorRuntimeOperationRecord;
}

function targetForMachine(machine: MachineRecord) {
  const runtime = machine.connector.runtime;
  return runtime && connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
}

export function connectorRuntimeExpectedFingerprint(
  machine: MachineRecord,
  approved: ConnectorRuntimeVerifiedRelease
): ConnectorRuntimeFingerprint {
  const runtime = machine.connector.runtime!;
  return {
    buildId: approved.manifest.buildId,
    bundleVersions: { ...approved.artifact.bundleVersions },
    capabilities: [...approved.artifact.capabilities].sort(),
    instanceId: runtime.instanceId,
    protocolVersion: approved.artifact.protocolVersion,
    releaseId: approved.manifest.releaseId,
    version: approved.manifest.version
  };
}

function releaseFingerprintsEqual(
  left: ConnectorRuntimeFingerprint,
  right: ConnectorRuntimeFingerprint
) {
  return left.releaseId === right.releaseId && left.buildId === right.buildId &&
    left.version === right.version && left.protocolVersion === right.protocolVersion &&
    left.bundleVersions.connector === right.bundleVersions.connector &&
    left.bundleVersions.machineTools === right.bundleVersions.machineTools &&
    left.bundleVersions.projectCli === right.bundleVersions.projectCli &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index]);
}

function runtimeSatisfiesReleaseFingerprint(
  actual: ConnectorRuntimeFingerprint,
  expected: ConnectorRuntimeFingerprint
) {
  return actual.releaseId === expected.releaseId && actual.buildId === expected.buildId &&
    actual.version === expected.version && actual.protocolVersion === expected.protocolVersion &&
    actual.bundleVersions.connector === expected.bundleVersions.connector &&
    actual.bundleVersions.machineTools === expected.bundleVersions.machineTools &&
    actual.bundleVersions.projectCli === expected.bundleVersions.projectCli &&
    expected.capabilities.every((capability) => actual.capabilities.includes(capability));
}

function fingerprintsEqual(
  left: ConnectorRuntimeFingerprint,
  right: ConnectorRuntimeFingerprint
) {
  return left.instanceId === right.instanceId && releaseFingerprintsEqual(left, right);
}

export function connectorRuntimeUpdateMatchesApproved(
  operation: ConnectorRuntimeOperationRecord,
  approved: ConnectorRuntimeVerifiedRelease
) {
  const expected = operation.expectedFingerprint;
  if (!expected) return false;
  const approvedFingerprint: ConnectorRuntimeFingerprint = {
    ...expected,
    buildId: approved.manifest.buildId,
    bundleVersions: { ...approved.artifact.bundleVersions },
    capabilities: [...approved.artifact.capabilities].sort(),
    protocolVersion: approved.artifact.protocolVersion,
    releaseId: approved.manifest.releaseId,
    version: approved.manifest.version
  };
  return operation.operation === 'update' &&
    operation.expectedBuildId === approved.manifest.buildId &&
    operation.expectedReleaseId === approved.manifest.releaseId &&
    releaseFingerprintsEqual(expected, approvedFingerprint);
}

function operationConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && (
    ('code' in error && error.code === '23505') ||
    (error instanceof Error && error.message.includes('already active'))
  ));
}

export async function ensureConnectorRuntimeUpdatePending(input: {
  approved: ConnectorRuntimeVerifiedRelease | undefined;
  machine: MachineRecord;
  now: Date;
  operations: ConnectorRuntimeOperationStore;
}): Promise<PendingConnectorRuntimeUpdate | undefined> {
  const { approved, machine, operations } = input;
  const runtime = machine.connector.runtime;
  const target = targetForMachine(machine);
  const capabilities = machine.connector.capabilities ?? [];
  const online = machine.connector.status === 'online' || machine.connector.status === 'local';
  if (!approved || !online || !runtime || runtime.source !== 'managed' || !target ||
      !capabilities.includes('runtime.update')) return undefined;

  const now = input.now.toISOString();
  const latest = await operations.latest(machine.id);
  const expected = connectorRuntimeExpectedFingerprint(machine, approved);
  const actual = connectorRuntimeFingerprint(runtime, capabilities);
  const runtimeMatchesRelease = runtimeSatisfiesReleaseFingerprint(actual, expected);
  if (runtimeMatchesRelease && connectorCodexRuntimeMatchesExpected(machine, expected)) {
    if (latest?.state === 'queued' && connectorRuntimeUpdateMatchesApproved(latest, approved)) {
      const succeeded = await operations.transition({
        expectedStates: ['queued'], finishedAt: now, id: latest.id,
        lastFailure: null, state: 'succeeded', updatedAt: now
      });
      if (!succeeded) return undefined;
    }
    return undefined;
  }

  const versionOrder = compareConnectorRuntimeSemanticVersions(
    runtime.version,
    approved.manifest.version
  );
  if (versionOrder === undefined || versionOrder > 0) return undefined;

  const previous = actual;
  const deadlineAt = new Date(input.now.getTime() + connectorRuntimeUpdateTimeoutMs).toISOString();
  if (latest && !['failed', 'recovery-required', 'rolled-back', 'succeeded'].includes(latest.state)) {
    if (latest.operation !== 'update' || latest.state !== 'queued') return undefined;
    const queuedExpected = latest.expectedFingerprint;
    if (!queuedExpected || !latest.expectedReleaseId) return undefined;
    const targetOrder = compareConnectorRuntimeSemanticVersions(
      queuedExpected.version,
      approved.manifest.version
    );
    if (targetOrder === 0) {
      return connectorRuntimeUpdateMatchesApproved(latest, approved)
        ? { approved, operation: latest }
        : undefined;
    }
    if (targetOrder === undefined || targetOrder > 0 || !latest.previousFingerprint ||
        !fingerprintsEqual(previous, latest.previousFingerprint)) return undefined;
    const operation = await operations.coalesceQueuedUpdate({
      deadlineAt,
      expectedBuildId: approved.manifest.buildId,
      expectedFingerprint: expected,
      expectedReleaseId: approved.manifest.releaseId,
      fromExpectedFingerprint: queuedExpected,
      fromExpectedReleaseId: latest.expectedReleaseId,
      fromTarget: target,
      id: latest.id,
      preserveLastFailure: true,
      previousFingerprint: latest.previousFingerprint,
      previousInstanceId: latest.previousInstanceId,
      requestedReleaseId: approved.manifest.releaseId,
      target,
      updatedAt: now
    });
    return operation ? { approved, operation } : undefined;
  }

  if (latest?.operation === 'update' && latest.state !== 'succeeded' &&
      latest.expectedReleaseId === approved.manifest.releaseId) return undefined;

  try {
    const operation = await operations.createAccepted({
      deadlineAt,
      expectedBuildId: approved.manifest.buildId,
      expectedFingerprint: expected,
      expectedReleaseId: approved.manifest.releaseId,
      machineId: machine.id,
      operation: 'update',
      previousFingerprint: previous,
      previousInstanceId: runtime.instanceId,
      requestedByUserId: connectorRuntimeAutomaticUpdateActor,
      requestedReleaseId: approved.manifest.releaseId,
      target
    }, {
      at: now,
      machineId: machine.id,
      operation: 'update',
      outcome: 'accepted',
      releaseId: approved.manifest.releaseId,
      userId: connectorRuntimeAutomaticUpdateActor
    }, now);
    return { approved, operation };
  } catch (error) {
    if (!operationConflict(error)) throw error;
    const operation = await operations.latest(machine.id);
    return operation?.operation === 'update' && operation.state === 'queued' &&
      connectorRuntimeUpdateMatchesApproved(operation, approved)
      ? { approved, operation }
      : undefined;
  }
}
