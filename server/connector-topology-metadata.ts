import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import {
  arch,
  cpus,
  freemem,
  hostname,
  platform as hostPlatform,
  totalmem
} from 'node:os';

import type {
  ConnectorEnvironmentKind,
  ConnectorEnvironmentRecord
} from '../src/shared/project-space-api';
import type {
  ComputeEnvironmentKind,
  ComputePlatformKind,
  ConnectorComputeMetadata,
  DerivedIdentityKey,
  ResourceProfile
} from '../src/shared/compute-environment-api';
import { isConnectorComputeMetadataValue } from '../src/shared/compute-environment-api';

const executionScopeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const maximumEnvironmentLabelLength = 128;

interface ConnectorTopologyMetadataOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readMachineId?: () => string | undefined;
}

export interface ConnectorTopologyMetadata {
  compute?: ConnectorComputeMetadata;
  environment?: ConnectorEnvironmentRecord;
  executionScopeId?: string;
}

export function isConnectorComputeMetadata(value: unknown): value is ConnectorComputeMetadata {
  return isConnectorComputeMetadataValue(value);
}

function derivedIdentity(namespace: string, value: string): DerivedIdentityKey {
  return {
    key: `${namespace}:${createHash('sha256').update(value, 'utf8').digest('hex')}`,
    version: 1
  };
}

function readableIdentity(path: string) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value && value.length <= 256 ? value : undefined;
  } catch {
    return undefined;
  }
}

function resourceProfile(reportedAt: string): ResourceProfile {
  const processors = cpus();
  let storage: ResourceProfile['storage'] = { totalBytes: 0 };
  try {
    const filesystem = statfsSync('/', { bigint: true });
    storage = {
      availableBytes: Number(filesystem.bavail * filesystem.bsize),
      totalBytes: Number(filesystem.blocks * filesystem.bsize)
    };
  } catch {
    // A connector without filesystem telemetry remains usable.
  }
  return {
    architecture: arch(),
    cpu: {
      cores: processors.length || 1,
      model: processors[0]?.model
    },
    memory: {
      availableBytes: freemem(),
      totalBytes: totalmem()
    },
    operatingSystem: hostPlatform(),
    reportedAt,
    source: 'connector',
    storage
  };
}

function runtimeKinds(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): {
  environmentKind: ComputeEnvironmentKind;
  environmentName: string;
  platformKind: ComputePlatformKind;
  platformName: string;
} {
  if (environment.CODESPACES === 'true' || environment.CODESPACE_NAME) {
    return {
      environmentKind: 'github_codespace',
      environmentName: 'GitHub Codespace',
      platformKind: 'github_codespaces',
      platformName: 'GitHub Codespaces'
    };
  }
  if (environment.KUBERNETES_SERVICE_HOST) {
    return {
      environmentKind: 'kubernetes_workload',
      environmentName: 'Kubernetes workload',
      platformKind: 'kubernetes',
      platformName: 'Kubernetes'
    };
  }
  if (environment.WSL_DISTRO_NAME) {
    return {
      environmentKind: 'wsl',
      environmentName: environment.WSL_DISTRO_NAME,
      platformKind: 'local',
      platformName: 'Local & self-hosted'
    };
  }
  if (existsSync('/.dockerenv') || environment.CONTAINER === 'docker') {
    return {
      environmentKind: 'docker',
      environmentName: 'Docker container',
      platformKind: 'local',
      platformName: 'Local & self-hosted'
    };
  }
  const nativeKind: Record<string, ComputeEnvironmentKind> = {
    darwin: 'native_macos',
    linux: 'native_linux',
    win32: 'native_windows'
  };
  return {
    environmentKind: nativeKind[platform] ?? 'other',
    environmentName: hostname(),
    platformKind: 'local',
    platformName: 'Local & self-hosted'
  };
}

function computeMetadata(
  processEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  executionScopeId: string | undefined,
  machineId: string | undefined
): ConnectorComputeMetadata | undefined {
  const kinds = runtimeKinds(processEnvironment, platform);
  const providerManaged = kinds.platformKind !== 'local';
  const dmiIdentity = kinds.environmentKind === 'docker' || providerManaged
    ? undefined
    : readableIdentity('/sys/class/dmi/id/product_uuid');
  const managedIdentity = processEnvironment.PROJECT_COMPUTE_ENVIRONMENT_IDENTITY;
  const providerIdentity = kinds.environmentKind === 'github_codespace'
    ? processEnvironment.CODESPACE_NAME
    : kinds.environmentKind === 'kubernetes_workload'
      ? processEnvironment.HOSTNAME
      : kinds.environmentKind === 'docker'
        ? processEnvironment.HOSTNAME
        : undefined;
  const environmentSeed = managedIdentity || providerIdentity || executionScopeId || machineId;
  if (!environmentSeed) return undefined;
  const parentIdentity = processEnvironment.PROJECT_COMPUTE_PARENT_ENVIRONMENT_IDENTITY;

  return {
    environmentIdentity: derivedIdentity('environment', environmentSeed),
    environmentKind: kinds.environmentKind,
    environmentName: kinds.environmentName,
    hostEvidence: providerManaged ? 'provider' : dmiIdentity ? 'smbios' : 'none',
    hostIdentity: !providerManaged && dmiIdentity
      ? derivedIdentity('host', dmiIdentity)
      : undefined,
    hostName: !providerManaged && dmiIdentity ? hostname() : undefined,
    hostResolution: providerManaged ? 'not_applicable' : dmiIdentity ? 'verified' : 'unresolved',
    parentEnvironmentIdentity: parentIdentity
      ? derivedIdentity('environment', parentIdentity)
      : undefined,
    platformKind: kinds.platformKind,
    platformName: kinds.platformName,
    resourceMode: providerManaged || kinds.environmentKind === 'docker' || kinds.environmentKind === 'wsl'
      ? 'dedicated'
      : 'exclusive',
    resources: resourceProfile(new Date().toISOString())
  };
}

function isBoundedLabel(value: string) {
  return (
    value.length > 0 &&
    value.length <= maximumEnvironmentLabelLength &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function isConnectorEnvironmentRecord(
  value: unknown
): value is ConnectorEnvironmentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const environment = value as Record<string, unknown>;
  if (!Object.keys(environment).every((key) => key === 'kind' || key === 'label')) {
    return false;
  }
  const validKinds = new Set<ConnectorEnvironmentKind>(['linux', 'macos', 'windows', 'wsl']);
  return (
    typeof environment.kind === 'string' &&
    validKinds.has(environment.kind as ConnectorEnvironmentKind) &&
    (environment.label === undefined ||
      (typeof environment.label === 'string' && isBoundedLabel(environment.label)))
  );
}

export function isConnectorExecutionScopeId(value: unknown): value is string {
  return typeof value === 'string' && executionScopeIdPattern.test(value);
}

function connectorEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ConnectorEnvironmentRecord | undefined {
  const wslDistroName = environment.WSL_DISTRO_NAME;
  if (wslDistroName !== undefined) {
    return {
      kind: 'wsl',
      label: isBoundedLabel(wslDistroName) ? wslDistroName : undefined
    };
  }

  if (platform === 'darwin') return { kind: 'macos' };
  if (platform === 'win32') return { kind: 'windows' };
  if (platform === 'linux') return { kind: 'linux' };
  return undefined;
}

function localMachineId() {
  try {
    const value = readFileSync('/etc/machine-id', 'utf8').trim();
    return /^[A-Fa-f0-9]{16,128}$/.test(value) ? value.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function deterministicExecutionScopeId(
  environment: ConnectorEnvironmentRecord | undefined,
  machineId: string | undefined
) {
  if (!environment || !machineId || (environment.kind === 'wsl' && !environment.label)) {
    return undefined;
  }
  const fingerprint = [
    'project-connector-execution-scope-v1',
    environment.kind,
    environment.label ?? '',
    machineId
  ].join('\0');
  return `scope-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 40)}`;
}

export function loadConnectorTopologyMetadata(
  options: ConnectorTopologyMetadataOptions = {}
): ConnectorTopologyMetadata {
  const processEnvironment = options.environment ?? process.env;
  const environment = connectorEnvironment(
    processEnvironment,
    options.platform ?? hostPlatform()
  );
  const override = processEnvironment.PROJECT_CONNECTOR_EXECUTION_SCOPE_ID;
  const machineId = (options.readMachineId ?? localMachineId)();
  const executionScopeId = isConnectorExecutionScopeId(override)
    ? override
    : deterministicExecutionScopeId(environment, machineId);

  return {
    compute: computeMetadata(processEnvironment, options.platform ?? hostPlatform(), executionScopeId, machineId),
    environment,
    executionScopeId
  };
}
