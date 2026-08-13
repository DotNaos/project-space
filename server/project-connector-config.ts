import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ProjectConnectorConfig {
  machineId?: string;
}

/**
 * Reads the local machine identity override used by direct local development.
 * Connector hub URLs, registration credentials, and command signing keys are
 * intentionally no longer part of the server configuration surface.
 */
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

function connectorConfigPath() {
  return process.env.PROJECT_CONNECTOR_CONFIG?.trim() ||
    join(homedir(), '.config', 'project-space', 'connector.json');
}
