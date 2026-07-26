import { describe, expect, test } from 'bun:test';

import { connectorRuntimeRecord } from '../server/connector-build-info';

describe('connector build information', () => {
  test('uses the next immutable release version for source builds', () => {
    const record = connectorRuntimeRecord({});

    expect(record.version).toBe('0.4.27');
    expect(record.releaseId).toBe('dev-0.4.27');
    expect(record.bundleVersions).toEqual({
      connector: '0.4.27', machineTools: '0.4.27', projectCli: '0.4.27'
    });
  });

  test('carries exact supervisor maintenance evidence into the handshake', () => {
    expect(connectorRuntimeRecord({
      PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'operation-1',
      PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check'
    }).maintenance).toEqual({
      operationId: 'operation-1', state: 'pending-health-check'
    });
  });

  test('fails closed on partial, arbitrary, or malformed maintenance evidence', () => {
    for (const environment of [
      { PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'operation-1' },
      {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'operation-1',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'succeeded'
      },
      {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: '../operation',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'rolled-back'
      }
    ]) {
      expect(() => connectorRuntimeRecord(environment)).toThrow(
        'maintenance evidence is invalid'
      );
    }
  });
});
