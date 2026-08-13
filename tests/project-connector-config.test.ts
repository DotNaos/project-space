import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import {
  configuredConnectorMachineId
} from '../server/project-connector-config';

const originalConfig = process.env.PROJECT_CONNECTOR_CONFIG;
const originalMachineId = process.env.PROJECT_CONNECTOR_MACHINE_ID;

afterEach(() => {
  if (originalConfig === undefined) {
    delete process.env.PROJECT_CONNECTOR_CONFIG;
  } else {
    process.env.PROJECT_CONNECTOR_CONFIG = originalConfig;
  }
  if (originalMachineId === undefined) {
    delete process.env.PROJECT_CONNECTOR_MACHINE_ID;
  } else {
    process.env.PROJECT_CONNECTOR_MACHINE_ID = originalMachineId;
  }
});

describe('local machine identity configuration', () => {
  test('reads the configured machine identity without loading Connector credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-connector-config-'));
    const configPath = join(directory, 'connector.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        machineId: 'connector-018f4c26-63e3-7cb2-a3fc-0f4f3067e299',
      })
    );
    process.env.PROJECT_CONNECTOR_CONFIG = configPath;
    delete process.env.PROJECT_CONNECTOR_MACHINE_ID;

    try {
      expect(configuredConnectorMachineId()).toBe(
        'connector-018f4c26-63e3-7cb2-a3fc-0f4f3067e299'
      );
      process.env.PROJECT_CONNECTOR_MACHINE_ID = ' connector-not-canonical';
      expect(() => configuredConnectorMachineId()).toThrow('invalid machineId');
      delete process.env.PROJECT_CONNECTOR_MACHINE_ID;

    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
