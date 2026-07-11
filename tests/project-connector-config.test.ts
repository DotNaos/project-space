import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import {
  connectorCommandGrantPublicKeyForTarget,
  configuredConnectorMachineId,
  connectorRegistrationTokenForTarget,
  resolveProjectConnectorTargets
} from '../server/project-connector-config';

const originalConfig = process.env.PROJECT_CONNECTOR_CONFIG;
const originalHubs = process.env.PROJECT_CONNECTOR_HUBS;
const originalToken = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;
const originalTokenFile = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE;
const originalMachineId = process.env.PROJECT_CONNECTOR_MACHINE_ID;

afterEach(() => {
  if (originalConfig === undefined) {
    delete process.env.PROJECT_CONNECTOR_CONFIG;
  } else {
    process.env.PROJECT_CONNECTOR_CONFIG = originalConfig;
  }
  if (originalHubs === undefined) {
    delete process.env.PROJECT_CONNECTOR_HUBS;
  } else {
    process.env.PROJECT_CONNECTOR_HUBS = originalHubs;
  }
  if (originalToken === undefined) {
    delete process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;
  } else {
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = originalToken;
  }
  if (originalTokenFile === undefined) {
    delete process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE;
  } else {
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE = originalTokenFile;
  }
  if (originalMachineId === undefined) {
    delete process.env.PROJECT_CONNECTOR_MACHINE_ID;
  } else {
    process.env.PROJECT_CONNECTOR_MACHINE_ID = originalMachineId;
  }
});

describe('connector hub targets', () => {
  test('derives the authenticated command socket from an HTTPS hub URL', () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    process.env.PROJECT_CONNECTOR_HUBS = JSON.stringify([
      { name: 'prod', url: 'https://projects.os-home.net/' }
    ]);

    expect(resolveProjectConnectorTargets()).toEqual([
      {
        name: 'prod',
        registrationTokenEnv: 'PROJECT_CONNECTOR_REGISTRATION_TOKEN',
        url: 'https://projects.os-home.net',
        wsUrl: 'wss://projects.os-home.net/api/connectors/socket'
      }
    ]);
  });

  test('reads connector credentials and public grant keys from private files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-connector-config-'));
    const configPath = join(directory, 'connector.json');
    const tokenPath = join(directory, 'registration-token');
    const publicKeyPath = join(directory, 'command-public.pem');
    writeFileSync(tokenPath, 'connector-specific-token\n', { mode: 0o600 });
    writeFileSync(publicKeyPath, 'test-public-key\n', { mode: 0o644 });
    writeFileSync(
      configPath,
      JSON.stringify({
        hubs: [
          {
            commandGrantPublicKeyFile: publicKeyPath,
            name: 'prod',
            url: 'https://projects.os-home.net'
          }
        ],
        machineId: 'connector-018f4c26-63e3-7cb2-a3fc-0f4f3067e299',
        registrationTokenFile: tokenPath
      })
    );
    process.env.PROJECT_CONNECTOR_CONFIG = configPath;
    delete process.env.PROJECT_CONNECTOR_HUBS;
    delete process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;
    delete process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN_FILE;
    delete process.env.PROJECT_CONNECTOR_MACHINE_ID;

    try {
      const [target] = resolveProjectConnectorTargets();
      expect(connectorRegistrationTokenForTarget(target)).toBe('connector-specific-token');
      expect(String(connectorCommandGrantPublicKeyForTarget(target))).toBe('test-public-key\n');
      expect(configuredConnectorMachineId()).toBe(
        'connector-018f4c26-63e3-7cb2-a3fc-0f4f3067e299'
      );
      process.env.PROJECT_CONNECTOR_MACHINE_ID = ' connector-not-canonical';
      expect(() => configuredConnectorMachineId()).toThrow('invalid machineId');
      delete process.env.PROJECT_CONNECTOR_MACHINE_ID;

      chmodSync(tokenPath, 0o644);
      expect(connectorRegistrationTokenForTarget(target)).toBe('');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
