import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ProjectConnectorHubTarget {
  name: string;
  url?: string;
  wsUrl?: string;
  registrationTokenEnv?: string;
  disabled?: boolean;
}

interface ProjectConnectorConfig {
  hubs?: ProjectConnectorHubTarget[];
}

interface ResolveProjectConnectorTargetsOptions {
  hubHttpUrl?: string;
  hubUrl?: string;
}

const defaultConnectorTokenEnv = 'PROJECT_CONNECTOR_REGISTRATION_TOKEN';

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

function readConfiguredConnectorTargets() {
  const path = connectorConfigPath();
  if (!path || !existsSync(path)) {
    return [];
  }

  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as ProjectConnectorConfig;
    return Array.isArray(config.hubs) ? config.hubs : [];
  } catch (error) {
    console.warn(
      `Could not read connector config ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
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
      console.warn(
        `Could not parse PROJECT_CONNECTOR_HUBS: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
    name: target.name?.trim() || targetNameFromURL(target.url ?? target.wsUrl ?? 'hub'),
    registrationTokenEnv: target.registrationTokenEnv?.trim() || defaultConnectorTokenEnv,
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
  if (targetTokenEnv && process.env[targetTokenEnv]) {
    return process.env[targetTokenEnv];
  }
  return process.env[namedTokenEnv] ?? process.env[defaultConnectorTokenEnv];
}

function connectorConfigPath() {
  if (process.env.PROJECT_CONNECTOR_CONFIG?.trim()) {
    return process.env.PROJECT_CONNECTOR_CONFIG.trim();
  }
  return join(homedir(), '.config', 'project-space', 'connector.json');
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
