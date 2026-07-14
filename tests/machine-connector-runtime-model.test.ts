import { describe, expect, test } from 'bun:test';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  canRestartMachineRuntime,
  canUpdateMachineRuntime,
  isRuntimeBusy,
  runtimeOperationLabel,
  runtimeStateLabel,
  runtimeUnavailableReason
} from '../src/features/project-desktop/components/machine-connector-runtime-model';

function machine(overrides: Partial<MachineRecord['connector']> = {}): MachineRecord {
  return {
    connector: {
      installCommand: 'project connector install',
      status: 'online',
      update: { state: 'up-to-date' },
      ...overrides
    },
    id: 'machine-1',
    kind: 'connector',
    name: 'Test machine',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('machine connector runtime actions', () => {
  test('keeps restart available when the connector is current', () => {
    const current = machine();
    expect(canRestartMachineRuntime(current)).toBe(true);
    expect(canUpdateMachineRuntime(current)).toBe(false);
  });

  test('offers only an approved update for update states', () => {
    const available = machine({
      update: {
        availableReleaseId: 'release-2',
        availableVersion: '2.0.0',
        state: 'update-required'
      }
    });
    expect(canUpdateMachineRuntime(available)).toBe(true);
    expect(
      canUpdateMachineRuntime(
        machine({ update: { availableVersion: '2.0.0', state: 'update-required' } })
      )
    ).toBe(false);
  });

  test('blocks conflicting actions while an operation is active', () => {
    const updating = machine({
      update: {
        availableReleaseId: 'release-2',
        operation: {
          createdAt: '2026-07-13T00:00:00.000Z',
          id: 'operation-1',
          machineId: 'machine-1',
          operation: 'update',
          requestedByUserId: 'user-1',
          state: 'reconnecting',
          updatedAt: '2026-07-13T00:01:00.000Z'
        },
        state: 'updating'
      }
    });

    expect(isRuntimeBusy(updating.connector.update)).toBe(true);
    expect(canUpdateMachineRuntime(updating)).toBe(false);
    expect(canRestartMachineRuntime(updating)).toBe(false);
    expect(runtimeUnavailableReason(updating, 'restart')).toContain('reconnect');
  });

  test('fails closed for offline and unsupported machines', () => {
    const offline = machine({ status: 'offline', update: { state: 'offline' } });
    const unsupported = machine({ update: { state: 'unsupported' } });

    expect(canRestartMachineRuntime(offline)).toBe(false);
    expect(runtimeUnavailableReason(offline, 'restart')).toBe('The machine is offline.');
    expect(canRestartMachineRuntime(unsupported)).toBe(false);
    expect(runtimeUnavailableReason(unsupported, 'restart')).toContain('cannot be managed');
  });

  test('uses honest state and operation labels', () => {
    expect(runtimeStateLabel('rollback')).toBe('Rolled back');
    expect(runtimeStateLabel(undefined)).toBe('Version unknown');
    expect(
      runtimeOperationLabel({
        createdAt: '2026-07-13T00:00:00.000Z',
        id: 'operation-1',
        machineId: 'machine-1',
        operation: 'restart',
        requestedByUserId: 'user-1',
        state: 'succeeded',
        updatedAt: '2026-07-13T00:01:00.000Z'
      })
    ).toBe('Restart complete');
  });
});
