import type {
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeRecord,
  MachineRuntimeStatusResult
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import type {
  ConnectorRuntimeReleaseArtifact,
  ConnectorRuntimeReleaseManifest
} from './connector-runtime-release-manifest';

const terminalStates = new Set<ConnectorRuntimeOperationRecord['state']>([
  'failed',
  'recovery-required',
  'rolled-back',
  'succeeded'
]);

const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function compareNumericIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareConnectorRuntimeSemanticVersions(
  left: string,
  right: string
): -1 | 0 | 1 | undefined {
  const leftMatch = semanticVersionPattern.exec(left);
  const rightMatch = semanticVersionPattern.exec(right);
  if (!leftMatch || !rightMatch) return undefined;

  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareNumericIdentifier(leftMatch[index]!, rightMatch[index]!);
    if (comparison !== 0) return comparison;
  }

  const leftPreRelease = leftMatch[4]?.split('.');
  const rightPreRelease = rightMatch[4]?.split('.');
  if (!leftPreRelease || !rightPreRelease) {
    if (!leftPreRelease && !rightPreRelease) return 0;
    return leftPreRelease ? -1 : 1;
  }
  const length = Math.max(leftPreRelease.length, rightPreRelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPreRelease[index];
    const rightIdentifier = rightPreRelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export interface ConnectorRuntimeApprovedRelease {
  artifact: ConnectorRuntimeReleaseArtifact;
  checkedAt: string;
  manifest: ConnectorRuntimeReleaseManifest;
}

export function connectorRuntimeFingerprint(
  runtime: ConnectorRuntimeRecord,
  capabilities: readonly string[]
): ConnectorRuntimeFingerprint {
  return {
    buildId: runtime.buildId,
    bundleVersions: { ...runtime.bundleVersions },
    capabilities: [...new Set(capabilities)].sort(),
    instanceId: runtime.instanceId,
    protocolVersion: runtime.protocolVersion,
    releaseId: runtime.releaseId,
    version: runtime.version
  };
}

export function runtimeMatchesExpectedFingerprint(
  runtime: ConnectorRuntimeRecord,
  capabilities: readonly string[],
  expected: ConnectorRuntimeFingerprint | undefined,
  previousInstanceId: string | undefined
) {
  if (!expected || runtime.instanceId === previousInstanceId) return false;
  const actual = connectorRuntimeFingerprint(runtime, capabilities);
  return actual.buildId === expected.buildId &&
    actual.version === expected.version &&
    actual.protocolVersion === expected.protocolVersion &&
    actual.releaseId === expected.releaseId &&
    actual.bundleVersions.connector === expected.bundleVersions.connector &&
    actual.bundleVersions.machineTools === expected.bundleVersions.machineTools &&
    actual.bundleVersions.projectCli === expected.bundleVersions.projectCli &&
    expected.capabilities.every((capability) => actual.capabilities.includes(capability));
}

function progressState(operation: ConnectorRuntimeOperationRecord) {
  if (operation.state === 'rolling-back' || operation.state === 'rolled-back') {
    return 'rollback' as const;
  }
  if (operation.state === 'failed' || operation.state === 'recovery-required') {
    return 'failed' as const;
  }
  if (!terminalStates.has(operation.state)) {
    return operation.operation === 'restart' ? 'restarting' as const : 'updating' as const;
  }
  return undefined;
}

export function connectorRuntimeRollbackAllowsRelease(
  operation: ConnectorRuntimeOperationRecord,
  releaseId: string | undefined
) {
  if (operation.state !== 'rolled-back' || operation.operation !== 'update' || !releaseId) {
    return false;
  }
  const targetReleaseIds = [
    operation.expectedReleaseId,
    operation.expectedFingerprint?.releaseId
  ].filter((releaseId): releaseId is string => Boolean(releaseId));
  const targetBuildIds = [
    operation.expectedBuildId,
    operation.expectedFingerprint?.buildId
  ].filter((buildId): buildId is string => Boolean(buildId));
  return targetReleaseIds.length > 0 &&
    targetReleaseIds.every((targetReleaseId) => targetReleaseId === targetReleaseIds[0]) &&
    targetBuildIds.length > 0 &&
    targetBuildIds.every((targetBuildId) => targetBuildId === targetBuildIds[0]) &&
    releaseId !== targetReleaseIds[0];
}

function supportsManagedUpdate(machine: MachineRecord, runtime: ConnectorRuntimeRecord) {
  const capabilities = machine.connector.capabilities ?? [];
  const targetSupported =
    (runtime.platform === 'darwin' && runtime.architecture === 'arm64') ||
    (runtime.platform === 'linux' && runtime.architecture === 'x64');
  return runtime.source === 'managed' && targetSupported &&
    capabilities.includes('runtime.update');
}

export function projectMachineRuntimeStatus(input: {
  approved?: ConnectorRuntimeApprovedRelease;
  machine: MachineRecord;
  operation?: ConnectorRuntimeOperationRecord | null;
}): MachineRuntimeStatusResult {
  const { approved, machine } = input;
  const capabilities = [...new Set(machine.connector.capabilities ?? [])].sort();
  const online = machine.connector.status === 'online' || machine.connector.status === 'local';
  const runtime = machine.connector.runtime;
  const operation = input.operation ?? undefined;
  const completedRollback = operation?.state === 'rolled-back';
  const activeState = operation && !completedRollback ? progressState(operation) : undefined;
  const base = {
    capabilities,
    machineId: machine.id,
    online,
    runtime,
    update: {
      ...(operation?.lastFailure ? { lastFailure: operation.lastFailure } : {}),
      ...(operation ? { operation } : {})
    }
  };
  const rolledBackResult = () => ({
    ...base,
    update: { ...base.update, state: 'rollback' as const }
  });

  if (activeState) {
    return { ...base, update: { ...base.update, state: activeState } };
  }
  if (!online) {
    if (completedRollback) return rolledBackResult();
    return { ...base, update: { ...base.update, state: 'offline' } };
  }
  if (!runtime || !supportsManagedUpdate(machine, runtime)) {
    if (completedRollback) return rolledBackResult();
    return { ...base, update: { ...base.update, state: 'unsupported' } };
  }
  if (!approved) {
    if (completedRollback) return rolledBackResult();
    return { ...base, update: { ...base.update, state: 'unknown' } };
  }

  const { artifact, checkedAt, manifest } = approved;
  const releaseDetails = {
    availableCapabilities: [...artifact.capabilities].sort(),
    availableReleaseId: manifest.releaseId,
    availableVersion: manifest.version,
    lastCheckedAt: checkedAt
  };
  const versionOrder = compareConnectorRuntimeSemanticVersions(
    runtime.version,
    manifest.version
  );
  if (versionOrder === undefined || versionOrder > 0) {
    if (completedRollback) return rolledBackResult();
    return {
      ...base,
      update: { ...base.update, ...releaseDetails, state: 'unsupported' }
    };
  }
  const sameRelease = runtime.releaseId === manifest.releaseId &&
    runtime.buildId === manifest.buildId &&
    runtime.version === manifest.version &&
    runtime.bundleVersions.connector === artifact.bundleVersions.connector &&
    runtime.bundleVersions.machineTools === artifact.bundleVersions.machineTools &&
    runtime.bundleVersions.projectCli === artifact.bundleVersions.projectCli;
  if (sameRelease) {
    if (completedRollback) return rolledBackResult();
    return {
      ...base,
      update: { ...base.update, ...releaseDetails, state: 'up-to-date' }
    };
  }

  const incompatible = runtime.protocolVersion !== artifact.protocolVersion ||
    artifact.capabilities.some((capability) => !capabilities.includes(capability));
  if (operation?.state === 'rolled-back' &&
      !connectorRuntimeRollbackAllowsRelease(operation, manifest.releaseId)) {
    return rolledBackResult();
  }
  return {
    ...base,
    update: {
      ...base.update,
      ...releaseDetails,
      state: incompatible ? 'update-required' : 'update-available'
    }
  };
}
