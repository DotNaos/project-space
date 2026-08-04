import type {
  ConnectorRuntimeArchitecture,
  ConnectorRuntimeChannel,
  ConnectorRuntimeMaintenanceEvidence,
  ConnectorRuntimePlatform,
  ConnectorRuntimeRecord,
  ConnectorRuntimeSource
} from '../src/shared/project-space-api';
import { randomUUID } from 'node:crypto';

declare const __PROJECT_SPACE_BUILD_ID__: string | undefined;
declare const __PROJECT_SPACE_RELEASE_ID__: string | undefined;
declare const __PROJECT_SPACE_VERSION__: string | undefined;

const developmentVersion = '0.4.58';
const protocolVersion = '2';
const runtimeInstanceId = randomUUID();
const maintenanceOperationPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function compiledValue(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function runtimePlatform(): ConnectorRuntimePlatform {
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
    return process.platform === 'win32' ? 'windows' : process.platform;
  }
  throw new Error(`Unsupported connector platform: ${process.platform}`);
}

function runtimeArchitecture(): ConnectorRuntimeArchitecture {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch;
  throw new Error(`Unsupported connector architecture: ${process.arch}`);
}

function runtimeChannel(environment: NodeJS.ProcessEnv): ConnectorRuntimeChannel {
  const value = environment.PROJECT_SPACE_RELEASE_CHANNEL?.trim();
  return value === 'stable' || value === 'beta' || value === 'dev' ? value : 'stable';
}

function runtimeSource(environment: NodeJS.ProcessEnv): ConnectorRuntimeSource {
  const value = environment.PROJECT_SPACE_INSTALL_SOURCE?.trim();
  return value === 'managed' ||
    value === 'homebrew' ||
    value === 'winget' ||
    value === 'source' ||
    value === 'legacy'
    ? value
    : 'unknown';
}

function runtimeMaintenance(
  environment: NodeJS.ProcessEnv
): ConnectorRuntimeMaintenanceEvidence | undefined {
  const operationId = environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID?.trim();
  const state = environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE?.trim();
  if (!operationId && !state) return undefined;
  if (!operationId || !maintenanceOperationPattern.test(operationId) ||
      (state !== 'pending-health-check' && state !== 'rolled-back')) {
    throw new Error('Connector runtime maintenance evidence is invalid.');
  }
  return { operationId, state };
}

export function connectorRuntimeRecord(
  environment: NodeJS.ProcessEnv = process.env,
  checkedAt = new Date().toISOString()
): ConnectorRuntimeRecord {
  const version = compiledValue(
    typeof __PROJECT_SPACE_VERSION__ === 'undefined' ? undefined : __PROJECT_SPACE_VERSION__,
    developmentVersion
  );
  const releaseId = compiledValue(
    typeof __PROJECT_SPACE_RELEASE_ID__ === 'undefined' ? undefined : __PROJECT_SPACE_RELEASE_ID__,
    environment.PROJECT_SPACE_RELEASE_ID?.trim() || `dev-${version}`
  );
  const buildId = compiledValue(
    typeof __PROJECT_SPACE_BUILD_ID__ === 'undefined' ? undefined : __PROJECT_SPACE_BUILD_ID__,
    environment.PROJECT_SPACE_BUILD_ID?.trim() || 'development'
  );
  const maintenance = runtimeMaintenance(environment);

  return {
    architecture: runtimeArchitecture(),
    buildId,
    bundleVersions: {
      connector: version,
      machineTools: version,
      projectCli: version
    },
    channel: runtimeChannel(environment),
    instanceId: runtimeInstanceId,
    lastCheckedAt: checkedAt,
    ...(maintenance ? { maintenance } : {}),
    platform: runtimePlatform(),
    protocolVersion,
    releaseId,
    source: runtimeSource(environment),
    version
  };
}

export function clearConnectorRuntimeMaintenanceEvidence(
  evidence: ConnectorRuntimeMaintenanceEvidence,
  environment: NodeJS.ProcessEnv = process.env
) {
  const operationId = environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID?.trim();
  const state = environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE?.trim();
  if (operationId !== evidence.operationId || state !== evidence.state) return false;
  delete environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID;
  delete environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE;
  return true;
}

export const connectorRuntimeProtocolVersion = protocolVersion;
