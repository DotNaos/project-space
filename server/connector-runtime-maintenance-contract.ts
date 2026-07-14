export type ConnectorRuntimeMaintenanceOperation = 'restart' | 'update';

export interface ConnectorRuntimeMaintenanceBrowserRequest {
  machineId: string;
  operation: ConnectorRuntimeMaintenanceOperation;
  releaseId?: string;
}

export type ConnectorRuntimeReleaseTarget =
  | 'darwin-arm64'
  | 'linux-x64'
  | 'windows-x64';

export type ConnectorRuntimeOperatingSystem = 'darwin' | 'linux' | 'windows';
export type ConnectorRuntimeArchitecture = 'amd64' | 'arm64' | 'x64';

const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && machineIdPattern.test(value);
}

function isReleaseId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    releaseIdPattern.test(value) &&
    value.toLowerCase() !== 'latest'
  );
}

export function isConnectorRuntimeMaintenanceBrowserRequest(
  value: unknown
): value is ConnectorRuntimeMaintenanceBrowserRequest {
  if (!isRecord(value) || !isMachineId(value.machineId)) {
    return false;
  }

  if (value.operation === 'restart') {
    return hasExactKeys(value, ['machineId', 'operation']);
  }

  if (value.operation !== 'update') {
    return false;
  }

  if (value.releaseId === undefined) {
    return hasExactKeys(value, ['machineId', 'operation']);
  }

  return (
    hasExactKeys(value, ['machineId', 'operation', 'releaseId']) &&
    isReleaseId(value.releaseId)
  );
}

export class ConnectorRuntimeMaintenanceRequestError extends Error {
  readonly code = 'invalid-request';

  constructor() {
    super('The connector maintenance request is invalid.');
    this.name = 'ConnectorRuntimeMaintenanceRequestError';
  }
}

export function parseConnectorRuntimeMaintenanceBrowserRequest(
  value: unknown
): ConnectorRuntimeMaintenanceBrowserRequest {
  if (!isConnectorRuntimeMaintenanceBrowserRequest(value)) {
    throw new ConnectorRuntimeMaintenanceRequestError();
  }
  return { ...value };
}

export function connectorRuntimeReleaseTarget(
  operatingSystem: ConnectorRuntimeOperatingSystem,
  architecture: ConnectorRuntimeArchitecture
): ConnectorRuntimeReleaseTarget | undefined {
  if (operatingSystem === 'darwin' && architecture === 'arm64') {
    return 'darwin-arm64';
  }
  if (operatingSystem === 'linux' && (architecture === 'amd64' || architecture === 'x64')) {
    return 'linux-x64';
  }
  if (operatingSystem === 'windows' && (architecture === 'amd64' || architecture === 'x64')) {
    return 'windows-x64';
  }
  return undefined;
}
