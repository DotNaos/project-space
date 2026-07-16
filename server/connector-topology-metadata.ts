import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { platform as hostPlatform } from 'node:os';

import type {
  ConnectorEnvironmentKind,
  ConnectorEnvironmentRecord
} from '../src/shared/project-space-api';

const executionScopeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const maximumEnvironmentLabelLength = 128;

interface ConnectorTopologyMetadataOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readMachineId?: () => string | undefined;
}

export interface ConnectorTopologyMetadata {
  environment?: ConnectorEnvironmentRecord;
  executionScopeId?: string;
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
  const executionScopeId = isConnectorExecutionScopeId(override)
    ? override
    : deterministicExecutionScopeId(environment, (options.readMachineId ?? localMachineId)());

  return {
    environment,
    executionScopeId
  };
}
