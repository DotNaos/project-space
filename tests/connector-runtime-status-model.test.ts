import { describe, expect, test } from 'bun:test';

import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState,
  ConnectorRuntimeState,
  ConnectorRuntimeUpdateRecord
} from '../src/shared/connector-runtime-api';
import { connectorRuntimeStatusPresentation } from '../src/features/project-desktop/components/connector-runtime-status-model';

function operation(state: ConnectorRuntimeOperationState): ConnectorRuntimeOperationRecord {
  return {
    createdAt: '2026-08-10T12:00:00.000Z',
    id: `operation-${state}`,
    machineId: 'connector-one',
    operation: 'update',
    requestedByUserId: 'user-one',
    state,
    updatedAt: '2026-08-10T12:01:00.000Z'
  };
}

function update(
  state: ConnectorRuntimeState,
  operationState?: ConnectorRuntimeOperationState
): ConnectorRuntimeUpdateRecord {
  return {
    ...(operationState ? { operation: operation(operationState) } : {}),
    state
  };
}

describe('connector runtime status presentation', () => {
  test('uses one honest update-available label for optional and required updates', () => {
    expect(connectorRuntimeStatusPresentation([update('update-available')])).toEqual({
      label: 'Update available',
      status: 'update-available'
    });
    expect(connectorRuntimeStatusPresentation([update('update-required')])).toEqual({
      label: 'Update available',
      status: 'update-available'
    });
  });

  test('keeps queued work visibly pending before it starts updating', () => {
    expect(connectorRuntimeStatusPresentation([update('update-pending')])).toEqual({
      label: 'Update pending',
      status: 'update-pending'
    });
    expect(connectorRuntimeStatusPresentation([update('updating', 'queued')])).toEqual({
      label: 'Update pending',
      status: 'update-pending'
    });
  });

  test('aggregates a connector group to its most active update state', () => {
    expect(connectorRuntimeStatusPresentation([
      update('update-available'),
      update('update-pending'),
      update('updating', 'staging')
    ])).toEqual({ label: 'Updating', status: 'updating' });
  });

  test('stays hidden when no connector needs an update', () => {
    expect(connectorRuntimeStatusPresentation([update('up-to-date'), undefined])).toBeUndefined();
  });

  test('keeps stale failed and rolled-back updates visible until readiness succeeds', () => {
    for (const state of ['failed', 'rolled-back'] as const) {
      expect(connectorRuntimeStatusPresentation([{
        availableVersion: '1.2.0',
        operation: {
          acceptedAt: '2026-08-10T12:00:00.000Z',
          deadlineAt: '2026-08-10T12:10:00.000Z',
          expectedBuildId: 'b'.repeat(40),
          expectedReleaseId: 'v1.2.0',
          id: `operation-${state}`,
          machineId: 'machine-stale',
          operation: 'update',
          requestedAt: '2026-08-10T12:00:00.000Z',
          requestedByUserId: 'system:connector-auto-update',
          state,
          target: 'linux-x64',
          updatedAt: '2026-08-10T12:01:00.000Z'
        },
        state: state === 'failed' ? 'failed' : 'rollback'
      }])).toEqual({ label: 'Update available', status: 'update-available' });
    }
  });
});
