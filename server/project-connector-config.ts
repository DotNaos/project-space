import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { projectSpaceLogger, recordObservedError } from './observability';

export interface ProjectConnectorHubTarget {
  commandGrantPublicKeyEnv?: string;
  commandGrantPublicKeyFile?: string;
  name: string;
  registrationTokenFile?: string;
  url?: string;
  wsUrl?: string;
  registrationTokenEnv?: string;
  disabled?: boolean;
}

interface ProjectConnectorConfig {
  hubs?: ProjectConnectorHubTarget[];
  machineId?: string;
  registrationTokenFile?: string;
}

interface ResolveProjectConnectorTargetsOptions {
  hubHttpUrl?: string;
  hubUrl?: string;
}

const defaultConnectorTokenEnv = 'PROJECT_CONNECTOR_REGISTRATION_TOKEN';
const defaultCommandGrantPublicKeyEnv = 'PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY';

export function resolveProjectConnectorTargets(
  options: ResolveProjectConnectorTargetsOptions = {}
) {
  const targets = [
    ...readConfiguredConnectorTargets(),
    ...readEnvConnectorTargets(),
    ...readLegacyConnectorTargets(options)
  ];
  const byName = new Map<string, ProjectConnectorHubTarget>();

  for (const target of targets) {
    if (target.disabled) {
      continue;
    }
    const normalized = normalizeConnectorTarget(target);
    if (!normalized.url && !normalized.wsUrl) {
      continue;
    }
    byName.set(normalized.name, normalized);
  }

  return [...byName.values()];
}

export function connectorRegistrationHeaders(
  target: ProjectConnectorHubTarget
): Record<string, string> {
  const token = connectorRegistrationTokenForTarget(target);

  return token
    ? {
        Authorization: `Bearer ${token}`,
        'X-Project-Connector-Token': token
      }
    : {};
}

export function connectorRegistrationTokenForTarget(target: ProjectConnectorHubTarget) {
  return connectorRegistrationToken(target) ?? '';
}

export function connectorCommandGrantPublicKeyForTarget(target: ProjectConnectorHubTarget) {
  const namedKeyEnv = `PROJECT_CONNECTOR_${sanitizeEnvSegment(target.name)}_COMMAND_SIGNING_PUBLIC_KEY`;
  const targetKeyEnv = target.commandGrantPublicKeyEnv?.trim();
  const inlineKey =
    (targetKeyEnv ? process.env[targetKeyEnv] : undefined) ??
    process.env[namedKeyEnv] ??
    process.env[defaultCommandGrantPublicKeyEnv];
  if (inlineKey) {
    return inlineKey;
  }

  const configuredFile =
    target.commandGrantPublicKeyFile?.trim() ??
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY_FILE?.trim();
  if (!configuredFile) {
    return undefined;
  }
  const keyFile = resolveConfiguredPath(configuredFile);
  try {
    return readFileSync(keyFile);
  } catch {
    return undefined;
  }
}

export function configuredConnectorMachineId() {
  const raw = process.env.PROJECT_CONNECTOR_MACHINE_ID ?? readConnectorConfig()?.machineId;
  const configured = raw?.trim();
  if (!configured) {
    return undefined;
  }
  if (raw !== configured || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(configured)) {
    throw new Error('Connector config has an invalid machineId.');
  }
  return configured;
}

function readConnectorConfig(path = connectorConfigPath()) {
  if (!path || !existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectConnectorConfig;
  } catch {
    return undefined;
  }
}

function readConfiguredConnectorTargets() {
  const path = connectorConfigPath();
  if (!path || !existsSync(path)) {
    return [];
  }

  try {
    const config = readConnectorConfig(path);
    return Array.isArray(config?.hubs)
      ? config.hubs.map((target) => ({
          ...target,
          registrationTokenFile:
            target.registrationTokenFile ?? config.registrationTokenFile
        }))
      : [];
  } catch (error) {
    recordObservedError('connector', 'config_read_failed');
    projectSpaceLogger.warn('connector.config.read_failed', {
      component: 'connector',
      path
    }, error);
    return [];
  }
}

function readEnvConnectorTargets() {
  const raw = process.env.PROJECT_CONNECTOR_HUBS?.trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as ProjectConnectorHubTarget[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      recordObservedError('connector', 'environment_config_parse_failed');
      projectSpaceLogger.warn('connector.config.environment_parse_failed', {
        component: 'connector'
      }, error);
      return [];
    }
  }

  const targets: ProjectConnectorHubTarget[] = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [maybeName, ...urlParts] = entry.split('=');
      const hasName = urlParts.length > 0;
      return {
        name: hasName ? maybeName.trim() : `hub-${index + 1}`,
        url: hasName ? urlParts.join('=').trim() : entry
      };
    });
  return targets;
}

function readLegacyConnectorTargets(options: ResolveProjectConnectorTargetsOptions) {
  const url = options.hubHttpUrl ?? process.env.PROJECT_CONNECTOR_HUB_URL;
  const wsUrl = options.hubUrl ?? process.env.PROJECT_CONNECTOR_HUB_WS_URL;
  if (!url && !wsUrl) {
    return [];
  }
  const targets: ProjectConnectorHubTarget[] = [
    {
      name: 'legacy',
      url,
      wsUrl
    }
  ];
  return targets;
}

function normalizeConnectorTarget(target: ProjectConnectorHubTarget): ProjectConnectorHubTarget {
  const url = target.url?.trim().replace(/\/+$/, '');
  return {
    ...(target.commandGrantPublicKeyEnv?.trim()
      ? { commandGrantPublicKeyEnv: target.commandGrantPublicKeyEnv.trim() }
      : {}),
    ...(target.commandGrantPublicKeyFile?.trim()
      ? { commandGrantPublicKeyFile: target.commandGrantPublicKeyFile.trim() }
      : {}),
    name: target.name?.trim() || targetNameFromURL(target.url ?? target.wsUrl ?? 'hub'),
    registrationTokenEnv: target.registrationTokenEnv?.trim() || defaultConnectorTokenEnv,
    ...(target.registrationTokenFile?.trim()
      ? { registrationTokenFile: target.registrationTokenFile.trim() }
      : {}),
    url,
    wsUrl: target.wsUrl?.trim() || connectorWebSocketUrl(url)
  };
}

function connectorWebSocketUrl(raw?: string) {
  if (!raw) {
    return undefined;
  }

  try {
    const url = new URL(raw);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/connectors/socket';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function connectorRegistrationToken(target: ProjectConnectorHubTarget) {
  const namedTokenEnv = `PROJECT_CONNECTOR_${sanitizeEnvSegment(target.name)}_REGISTRATION_TOKEN`;
  const targetTokenEnv = target.registrationTokenEnv?.trim();
  const tokenFile =
    target.registrationTokenFile?.trim() ??
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE?.trim();
  if (tokenFile) {
    const token = readPrivateTokenFile(resolveConfiguredPath(tokenFile));
    if (token) {
      return token;
    }
  }
  if (targetTokenEnv && process.env[targetTokenEnv]) {
    return process.env[targetTokenEnv];
  }
  return process.env[namedTokenEnv] ?? process.env[defaultConnectorTokenEnv];
}

function readPrivateTokenFile(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      return undefined;
    }
    const token = readFileSync(path, 'utf8').trim();
    if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
      return undefined;
    }
    return token;
  } catch {
    return undefined;
  }
}

function connectorConfigPath() {
  if (process.env.PROJECT_CONNECTOR_CONFIG?.trim()) {
    return process.env.PROJECT_CONNECTOR_CONFIG.trim();
  }
  return join(homedir(), '.config', 'project-space', 'connector.json');
}

function resolveConfiguredPath(path: string) {
  const expandedPath = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expandedPath)
    ? expandedPath
    : resolve(dirname(connectorConfigPath()), expandedPath);
}

function sanitizeEnvSegment(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function targetNameFromURL(raw: string) {
  try {
    return new URL(raw).hostname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  } catch {
    return raw.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'hub';
  }
}
