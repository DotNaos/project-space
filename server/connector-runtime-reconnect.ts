import type {
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import { connectorRuntimeFingerprint } from './connector-runtime-status';

export const activeConnectorRuntimeOperationStates: ConnectorRuntimeOperationState[] = [
  'queued', 'validating', 'staging', 'verified', 'switching', 'restarting',
  'reconnecting', 'health-checking', 'rolling-back'
];

function fingerprintsEqual(
  left: ConnectorRuntimeFingerprint,
  right: ConnectorRuntimeFingerprint
) {
  return left.buildId === right.buildId && left.version === right.version &&
    left.protocolVersion === right.protocolVersion && left.releaseId === right.releaseId &&
    left.instanceId === right.instanceId &&
    left.bundleVersions.connector === right.bundleVersions.connector &&
    left.bundleVersions.machineTools === right.bundleVersions.machineTools &&
    left.bundleVersions.projectCli === right.bundleVersions.projectCli &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index]);
}

function runtimeSatisfiesExpected(
  actual: ConnectorRuntimeFingerprint,
  expected: ConnectorRuntimeFingerprint
) {
  return actual.buildId === expected.buildId && actual.version === expected.version &&
    actual.protocolVersion === expected.protocolVersion && actual.releaseId === expected.releaseId &&
    actual.bundleVersions.connector === expected.bundleVersions.connector &&
    actual.bundleVersions.machineTools === expected.bundleVersions.machineTools &&
    actual.bundleVersions.projectCli === expected.bundleVersions.projectCli &&
    expected.capabilities.every((capability) => actual.capabilities.includes(capability));
}

export function runtimeMatchesRollbackFingerprint(
  machine: MachineRecord,
  operation: ConnectorRuntimeOperationRecord
) {
  const runtime = machine.connector.runtime;
  const previous = operation.previousFingerprint;
  if (!runtime || !previous || previous.instanceId !== operation.previousInstanceId ||
      runtime.instanceId === operation.previousInstanceId) return false;
  const actual = connectorRuntimeFingerprint(runtime, machine.connector.capabilities ?? []);
  return fingerprintsEqual(actual, { ...previous, instanceId: actual.instanceId });
}

export function runtimeMatchesOperationFingerprint(
  machine: MachineRecord,
  operation: ConnectorRuntimeOperationRecord
) {
  const runtime = machine.connector.runtime;
  const expected = operation.expectedFingerprint;
  if (!runtime || !expected) return false;
  const actual = connectorRuntimeFingerprint(runtime, machine.connector.capabilities ?? []);
  if (!runtimeSatisfiesExpected(actual, expected)) return false;
  if (actual.instanceId !== operation.previousInstanceId) return true;
  const previous = operation.previousFingerprint;
  if (operation.operation !== 'update' || !previous) return false;
  const changedRelease = expected.releaseId !== previous.releaseId &&
    expected.buildId !== previous.buildId && expected.version !== previous.version;
  return changedRelease || (
    fingerprintsEqual(actual, previous) && runtimeSatisfiesExpected(previous, expected)
  );
}
