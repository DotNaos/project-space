import { describe, expect, test } from 'bun:test';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  canRestartMachineRuntime,
  canStopSourceDevelopmentMachineRuntime,
  canUpdateMachineRuntime,
  hasMachineRuntimeCapability,
  isSourceDevelopmentMachineRuntime,
  isRuntimeBusy,
  latestRuntimeFailure,
  runtimeApprovedReleaseId,
  runtimeOperationLabel,
  runtimeOperationOutcomeMessage,
  runtimeRetryOperation,
  runtimeStateLabel,
  runtimeUnavailableReason,
  shouldPollRuntimeStatus,
  shouldShowMachineRuntimeRestart,
  shouldShowMachineRuntimeStop,
  shouldShowMachineRuntimeUpdate,
  shouldShowManagedRuntimeReinstallNotice
} from '../src/features/project-desktop/components/machine-connector-runtime-model';

function machine(overrides: Partial<MachineRecord['connector']> = {}): MachineRecord {
  return {
    connector: {
      capabilities: ['runtime.restart', 'runtime.update'],
      installCommand: 'project connector install',
      runtime: {
        architecture: 'arm64',
        buildId: '0'.repeat(40),
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel: 'stable',
        instanceId: 'instance-1',
        lastCheckedAt: '2026-07-13T00:00:00.000Z',
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: 'managed',
        version: '1.0.0'
      },
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

function sourceDevelopmentMachine(
  overrides: Partial<MachineRecord['connector']> = {}
): MachineRecord {
  const baseline = machine();
  return machine({
    capabilities: ['runtime.stop'],
    profile: { channel: 'dev', source: 'source' },
    runtime: {
      ...baseline.connector.runtime!,
      channel: 'dev',
      source: 'source'
    },
    update: { state: 'unsupported' },
    ...overrides
  });
}

describe('machine connector runtime actions', () => {
  test('offers scoped stop only to an explicit source development connector', () => {
    const sourceDevelopment = sourceDevelopmentMachine();
    const selfReportedDevelopment = sourceDevelopmentMachine({
      profile: undefined,
      runtime: {
        ...sourceDevelopment.connector.runtime!,
        channel: 'dev',
        source: 'source'
      }
    });
    const nameOnlyDevelopment = sourceDevelopmentMachine({
      profile: undefined,
      runtime: {
        ...sourceDevelopment.connector.runtime!,
        channel: 'stable',
        source: 'managed'
      }
    });
    nameOnlyDevelopment.name = 'dev-machine';

    expect(isSourceDevelopmentMachineRuntime(sourceDevelopment)).toBe(true);
    expect(canStopSourceDevelopmentMachineRuntime(sourceDevelopment)).toBe(true);
    expect(shouldShowMachineRuntimeStop(sourceDevelopment)).toBe(true);
    expect(shouldShowMachineRuntimeRestart(sourceDevelopment)).toBe(false);
    expect(canStopSourceDevelopmentMachineRuntime(selfReportedDevelopment)).toBe(false);
    expect(shouldShowMachineRuntimeStop(selfReportedDevelopment)).toBe(false);
    expect(canStopSourceDevelopmentMachineRuntime(nameOnlyDevelopment)).toBe(false);
    expect(shouldShowMachineRuntimeStop(nameOnlyDevelopment)).toBe(false);
    expect(shouldShowMachineRuntimeStop(machine({ runtime: undefined }))).toBe(false);
  });

  test('fails scoped stop closed when offline, busy, or missing its capability', () => {
    const missingCapability = sourceDevelopmentMachine({ capabilities: [] });
    const offline = sourceDevelopmentMachine({ status: 'offline' });
    const busy = sourceDevelopmentMachine({
      update: {
        operation: {
          createdAt: '2026-07-13T00:00:00.000Z',
          id: 'operation-1',
          machineId: 'machine-1',
          operation: 'restart',
          requestedByUserId: 'user-1',
          state: 'reconnecting',
          updatedAt: '2026-07-13T00:01:00.000Z'
        },
        state: 'restarting'
      }
    });

    expect(canStopSourceDevelopmentMachineRuntime(missingCapability)).toBe(false);
    expect(runtimeUnavailableReason(missingCapability, 'stop')).toContain('stop support');
    expect(canStopSourceDevelopmentMachineRuntime(offline)).toBe(false);
    expect(runtimeUnavailableReason(offline, 'stop')).toBe('The machine is offline.');
    expect(canStopSourceDevelopmentMachineRuntime(busy)).toBe(false);
    expect(runtimeUnavailableReason(busy, 'stop')).toContain('reconnect');
  });

  test('suppresses managed maintenance actions and reinstall guidance for source development', () => {
    const sourceDevelopment = sourceDevelopmentMachine({
      capabilities: ['runtime.restart', 'runtime.stop', 'runtime.update'],
      update: {
        availableReleaseId: 'release-2',
        availableVersion: '2.0.0',
        state: 'update-available'
      }
    });
    const unsupportedSourceDevelopment = sourceDevelopmentMachine();
    const managedUpdate = machine({
      update: {
        availableReleaseId: 'release-2',
        availableVersion: '2.0.0',
        state: 'update-available'
      }
    });

    expect(canUpdateMachineRuntime(sourceDevelopment)).toBe(false);
    expect(canRestartMachineRuntime(sourceDevelopment)).toBe(false);
    expect(shouldShowMachineRuntimeUpdate(sourceDevelopment)).toBe(false);
    expect(shouldShowMachineRuntimeRestart(sourceDevelopment)).toBe(false);
    expect(shouldShowManagedRuntimeReinstallNotice(unsupportedSourceDevelopment)).toBe(false);
    expect(canUpdateMachineRuntime(managedUpdate)).toBe(true);
    expect(canRestartMachineRuntime(managedUpdate)).toBe(true);
    expect(shouldShowMachineRuntimeUpdate(managedUpdate)).toBe(true);
    expect(shouldShowMachineRuntimeRestart(managedUpdate)).toBe(true);
  });

  test('keeps restart available when the connector is current', () => {
    const current = machine();
    expect(canRestartMachineRuntime(current)).toBe(true);
    expect(canUpdateMachineRuntime(current)).toBe(false);
  });

  test('requires the negotiated capability for each maintenance operation', () => {
    const noCapabilities = machine({ capabilities: [] });
    const restartOnly = machine({ capabilities: ['runtime.restart'] });
    const updateOnly = machine({
      capabilities: ['runtime.update'],
      update: {
        availableReleaseId: 'release-2',
        availableVersion: '2.0.0',
        state: 'update-available'
      }
    });

    expect(hasMachineRuntimeCapability(noCapabilities, 'restart')).toBe(false);
    expect(canRestartMachineRuntime(noCapabilities)).toBe(false);
    expect(runtimeUnavailableReason(noCapabilities, 'restart')).toContain('restart support');
    expect(canRestartMachineRuntime(restartOnly)).toBe(true);
    expect(canUpdateMachineRuntime(restartOnly)).toBe(false);
    expect(canUpdateMachineRuntime(updateOnly)).toBe(true);
    expect(canRestartMachineRuntime(updateOnly)).toBe(false);
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
    expect(shouldPollRuntimeStatus(updating.connector.update)).toBe(true);
  });

  test('fails closed offline and unmanaged while preserving restart-only support', () => {
    const offline = machine({ status: 'offline', update: { state: 'offline' } });
    const restartOnly = machine({
      capabilities: ['runtime.restart'],
      update: { state: 'unsupported' }
    });
    const unmanaged = machine({
      runtime: { ...machine().connector.runtime!, source: 'legacy' },
      update: { state: 'unsupported' }
    });

    expect(canRestartMachineRuntime(offline)).toBe(false);
    expect(runtimeUnavailableReason(offline, 'restart')).toBe('The machine is offline.');
    expect(canRestartMachineRuntime(restartOnly)).toBe(true);
    expect(canRestartMachineRuntime(unmanaged)).toBe(false);
    expect(runtimeUnavailableReason(unmanaged, 'restart')).toContain('cannot be managed');
  });

  test('uses honest state and operation labels', () => {
    expect(runtimeStateLabel('update-pending')).toBe('Update pending');
    expect(isRuntimeBusy({ state: 'update-pending' })).toBe(true);
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

  test('stops polling after every terminal operation state', () => {
    for (const state of ['succeeded', 'failed', 'rolled-back', 'recovery-required'] as const) {
      const terminal = machine({
        update: {
          operation: {
            createdAt: '2026-07-13T00:00:00.000Z',
            id: `operation-${state}`,
            machineId: 'machine-1',
            operation: 'update',
            requestedByUserId: 'user-1',
            state,
            updatedAt: '2026-07-13T00:01:00.000Z'
          },
          state: state === 'failed' || state === 'recovery-required'
            ? 'failed'
            : state === 'rolled-back'
              ? 'rollback'
              : 'up-to-date'
        }
      });

      expect(shouldPollRuntimeStatus(terminal.connector.update)).toBe(false);
      if (state === 'recovery-required') {
        expect(canRestartMachineRuntime(terminal)).toBe(false);
      }
    }
  });

  test('retries the failed operation instead of assuming every failure was an update', () => {
    const failedRestart = machine({
      update: {
        operation: {
          createdAt: '2026-07-13T00:00:00.000Z',
          id: 'restart-failure',
          lastFailure: {
            at: '2026-07-13T00:01:00.000Z',
            code: 'restart-failed',
            message: 'The connector did not stop cleanly.',
            rollbackAvailable: false
          },
          machineId: 'machine-1',
          operation: 'restart',
          requestedByUserId: 'user-1',
          state: 'failed',
          updatedAt: '2026-07-13T00:01:00.000Z'
        },
        state: 'failed'
      }
    });
    const rolledBackUpdate = machine({
      update: {
        operation: {
          createdAt: '2026-07-13T00:00:00.000Z',
          expectedReleaseId: 'release-2',
          id: 'update-rollback',
          machineId: 'machine-1',
          operation: 'update',
          requestedByUserId: 'user-1',
          state: 'rolled-back',
          updatedAt: '2026-07-13T00:01:00.000Z'
        },
        state: 'rollback'
      }
    });

    expect(runtimeRetryOperation(failedRestart)).toBe('restart');
    expect(runtimeRetryOperation(rolledBackUpdate)).toBe('update');
    expect(runtimeApprovedReleaseId(rolledBackUpdate)).toBe('release-2');
    expect(canUpdateMachineRuntime(rolledBackUpdate)).toBe(true);
  });

  test('shows the newest failure and honest terminal outcome copy', () => {
    const failed = machine({
      runtime: {
        architecture: 'arm64',
        buildId: 'build-1',
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel: 'stable',
        instanceId: 'instance-1',
        lastCheckedAt: '2026-07-13T00:00:00.000Z',
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'release-1',
        source: 'managed',
        version: '1.0.0'
      },
      update: {
        lastFailure: {
          at: '2026-07-13T00:00:30.000Z',
          code: 'older',
          message: 'Older failure',
          rollbackAvailable: false
        },
        operation: {
          createdAt: '2026-07-13T00:00:00.000Z',
          id: 'operation-1',
          lastFailure: {
            at: '2026-07-13T00:01:00.000Z',
            code: 'newer',
            message: 'Newer operation failure',
            rollbackAvailable: true
          },
          machineId: 'machine-1',
          operation: 'update',
          requestedByUserId: 'user-1',
          state: 'failed',
          updatedAt: '2026-07-13T00:01:00.000Z'
        },
        state: 'failed'
      }
    });
    const rolledBack = machine({
      ...failed.connector,
      update: {
        operation: {
          ...failed.connector.update!.operation!,
          state: 'rolled-back'
        },
        state: 'rollback'
      }
    });

    expect(latestRuntimeFailure(failed.connector.update)?.code).toBe('newer');
    expect(runtimeOperationOutcomeMessage(failed, failed.connector.update?.operation)).toBe(
      'Newer operation failure'
    );
    expect(
      runtimeOperationOutcomeMessage(rolledBack, rolledBack.connector.update?.operation)
    ).toContain('previous connector version was restored');
  });
});
