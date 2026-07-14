import { describe, expect, test } from 'bun:test';

import {
  connectorRuntimeReleaseTarget,
  isConnectorRuntimeMaintenanceBrowserRequest,
  parseConnectorRuntimeMaintenanceBrowserRequest
} from '../server/connector-runtime-maintenance-contract';

describe('connector runtime maintenance browser contract', () => {
  test('accepts only stable machine ids and named operations', () => {
    expect(
      parseConnectorRuntimeMaintenanceBrowserRequest({
        machineId: 'connector-123:primary',
        operation: 'restart'
      })
    ).toEqual({ machineId: 'connector-123:primary', operation: 'restart' });
    expect(
      parseConnectorRuntimeMaintenanceBrowserRequest({
        machineId: 'connector-123',
        operation: 'update',
        releaseId: 'v0.5.0'
      })
    ).toEqual({
      machineId: 'connector-123',
      operation: 'update',
      releaseId: 'v0.5.0'
    });
    expect(
      isConnectorRuntimeMaintenanceBrowserRequest({
        machineId: 'connector-123',
        operation: 'update'
      })
    ).toBe(true);
  });

  test('rejects every arbitrary execution or artifact input', () => {
    const extras = {
      artifact: 'payload',
      command: 'rm -rf ~',
      packageContents: 'bytes',
      path: '/tmp/updater',
      platform: 'linux',
      url: 'https://attacker.invalid/update'
    };

    for (const [key, value] of Object.entries(extras)) {
      expect(
        isConnectorRuntimeMaintenanceBrowserRequest({
          machineId: 'connector-123',
          operation: 'update',
          releaseId: 'v0.5.0',
          [key]: value
        })
      ).toBe(false);
    }
  });

  test('rejects irrelevant release ids, mutable aliases, malformed ids, and extra keys', () => {
    for (const value of [
      { machineId: 'connector-123', operation: 'restart', releaseId: 'v0.5.0' },
      { machineId: 'connector-123', operation: 'update', releaseId: 'latest' },
      { machineId: '../connector', operation: 'update' },
      { machineId: 'connector-123', operation: 'install' },
      { machineId: 'connector-123', operation: 'restart', unexpected: true }
    ]) {
      expect(isConnectorRuntimeMaintenanceBrowserRequest(value)).toBe(false);
      expect(() => parseConnectorRuntimeMaintenanceBrowserRequest(value)).toThrow(
        'maintenance request is invalid'
      );
    }
  });

  test('maps only the explicitly supported platform and architecture pairs', () => {
    expect(connectorRuntimeReleaseTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(connectorRuntimeReleaseTarget('linux', 'amd64')).toBe('linux-x64');
    expect(connectorRuntimeReleaseTarget('linux', 'x64')).toBe('linux-x64');
    expect(connectorRuntimeReleaseTarget('windows', 'amd64')).toBe('windows-x64');
    expect(connectorRuntimeReleaseTarget('windows', 'x64')).toBe('windows-x64');
    expect(connectorRuntimeReleaseTarget('darwin', 'amd64')).toBeUndefined();
    expect(connectorRuntimeReleaseTarget('linux', 'arm64')).toBeUndefined();
    expect(connectorRuntimeReleaseTarget('windows', 'arm64')).toBeUndefined();
  });
});
