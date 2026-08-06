import { describe, expect, test } from 'bun:test';

import { evaluateMachineReadiness } from '../server/machine-readiness/model';
import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeRecord,
  MachineRuntimeStatusResult
} from '../src/shared/connector-runtime-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../src/shared/project-space-api';

const runtime: ConnectorRuntimeRecord = {
  architecture: 'x64',
  buildId: '0'.repeat(40),
  bundleVersions: { connector: '0.4.7', machineTools: '0.4.7', projectCli: '0.4.7' },
  channel: 'stable',
  instanceId: 'runtime-one',
  lastCheckedAt: '2026-07-24T00:00:00.000Z',
  platform: 'linux',
  protocolVersion: '2',
  releaseId: 'v0.4.7',
  source: 'managed',
  version: '0.4.7'
};

const physicalMachines: PhysicalMachineRecord[] = [
  { connectorIds: ['linux-stable'], id: 'physical-pc', name: 'os-pc' }
];

function connector(overrides: Partial<MachineRecord['connector']> = {}): MachineRecord {
  return {
    connector: {
      capabilities: ['runtime.restart', 'runtime.update'],
      installCommand: 'managed',
      runtime,
      status: 'online',
      ...overrides
    },
    id: 'linux-stable',
    kind: 'connector',
    name: 'Linux Stable',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function status(
  state: MachineRuntimeStatusResult['update']['state'],
  operation?: ConnectorRuntimeOperationRecord
): MachineRuntimeStatusResult {
  return {
    capabilities: ['runtime.restart', 'runtime.update'],
    machineId: 'linux-stable',
    online: true,
    runtime,
    update: {
      ...(state === 'update-available' || state === 'update-required'
        ? { availableReleaseId: 'v0.4.10', availableVersion: '0.4.10' }
        : {}),
      ...(operation ? { operation } : {}),
      state
    }
  };
}

function operation(state: ConnectorRuntimeOperationRecord['state']) {
  return {
    createdAt: '2026-07-24T00:00:00.000Z',
    id: 'repair-one',
    machineId: 'linux-stable',
    operation: 'update' as const,
    requestedByUserId: 'owner',
    state,
    updatedAt: '2026-07-24T00:00:01.000Z'
  };
}

function diagnose(input: {
  canRepair?: boolean;
  connector?: MachineRecord;
  generation?: number;
  runtimeStatus?: MachineRuntimeStatusResult;
}) {
  return evaluateMachineReadiness({
    canRepairConnector: () => input.canRepair ?? true,
    checkedAt: '2026-07-24T00:00:00.000Z',
    connectors: [input.connector ?? connector()],
    generationFor: () => input.generation,
    physicalMachineName: 'os-pc',
    physicalMachines,
    runtimeStatuses: input.runtimeStatus
      ? new Map([['linux-stable', input.runtimeStatus]])
      : undefined
  });
}

describe('canonical machine readiness model', () => {
  test('distinguishes ready, constrained repairable, and authorization-required states', () => {
    const ready = diagnose({
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }),
      generation: 4,
      runtimeStatus: {
        ...status('up-to-date'),
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }
    });
    expect(ready.state).toBe('ready');
    expect(ready.ready).toBe(true);
    expect(ready.plan).toBeUndefined();

    const repairableStatus = {
      ...status('restart-required'),
      capabilities: ['codex.machine-tasks.v1', 'runtime.restart']
    };
    const repairable = diagnose({
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.restart']
      }),
      runtimeStatus: repairableStatus
    });
    expect(repairable.state).toBe('repairable');
    expect(repairable.plan?.actions).toEqual([expect.objectContaining({
      connectorId: 'linux-stable',
      kind: 'restart-connector',
      operation: 'restart'
    })]);
    expect(repairable.plan?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnose({
      canRepair: false,
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.restart']
      }),
      runtimeStatus: repairableStatus
    }).state).toBe('authorization-required');
  });

  test('keeps unsupported Codex installation and offline machines honest', () => {
    expect(diagnose({ runtimeStatus: status('up-to-date') }).state)
      .toBe('manually-blocked');
    const partial = diagnose({ runtimeStatus: status('update-required') });
    expect(partial.state).toBe('manually-blocked');
    expect(partial.plan?.actions[0]).toEqual(expect.objectContaining({
      kind: 'update-connector',
      releaseId: 'v0.4.10'
    }));
    const signedRuntime = status('update-required');
    signedRuntime.update.availableCapabilities = [
      'codex.runtime.v1',
      'runtime.restart',
      'runtime.update'
    ];
    expect(diagnose({ runtimeStatus: signedRuntime }).state).toBe('repairable');
    const authorizationRequired = diagnose({
      connector: connector({
        capabilities: ['codex.authorization-required.v1', 'codex.runtime.v1', 'runtime.update']
      }),
      runtimeStatus: {
        ...status('up-to-date'),
        capabilities: [
          'codex.authorization-required.v1',
          'codex.runtime.v1',
          'runtime.update'
        ]
      }
    });
    expect(authorizationRequired.state).toBe('authorization-required');
    expect(authorizationRequired.nextAction).toEqual({
      command: 'project codex login --machine-id physical-pc --connector linux-stable',
      kind: 'supported-action',
      message: 'Authorize the managed Codex runtime with a device code.'
    });
    const authorizationUpdate = diagnose({
      connector: connector({
        capabilities: ['codex.authorization-required.v1', 'codex.runtime.v1', 'runtime.update']
      }),
      runtimeStatus: {
        ...signedRuntime,
        capabilities: [
          'codex.authorization-required.v1',
          'codex.runtime.v1',
          'runtime.update'
        ]
      }
    });
    expect(authorizationUpdate.state).toBe('repairable');
    expect(authorizationUpdate.plan?.actions).toEqual([
      expect.objectContaining({ kind: 'update-connector', releaseId: 'v0.4.10' })
    ]);
    expect(diagnose({
      connector: connector({ capabilities: ['codex.runtime.v1', 'runtime.update'] }),
      runtimeStatus: {
        ...status('up-to-date'),
        capabilities: ['codex.runtime.v1', 'runtime.update']
      }
    }).state).toBe('uncertain');
    expect(diagnose({}).state).toBe('uncertain');
    expect(diagnose({
      connector: connector({ status: 'offline' }),
      runtimeStatus: { ...status('offline'), online: false }
    }).state).toBe('unreachable');
  });

  test('preserves repairing, rollback, failed, and recovery states', () => {
    for (const [operationState, readinessState] of [
      ['reconnecting', 'repairing'],
      ['rolling-back', 'rolling-back'],
      ['rolled-back', 'rolled-back'],
      ['failed', 'failed'],
      ['recovery-required', 'recovery-required']
    ] as const) {
      expect(diagnose({
        connector: connector({ status: operationState === 'reconnecting' ? 'offline' : 'online' }),
        runtimeStatus: status('failed', operation(operationState))
      }).state).toBe(readinessState);
    }
  });

  test('is ready when the exact rolled-back target is now healthy', () => {
    const result = diagnose({
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }),
      generation: 4,
      runtimeStatus: {
        ...status('up-to-date', operation('rolled-back')),
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }
    });

    expect(result).toMatchObject({
      operation: { id: 'repair-one', state: 'rolled-back' },
      ready: true,
      state: 'ready'
    });
  });

  test('offers a new constrained update after a completed rollback', () => {
    const priorOperation = {
      ...operation('rolled-back'),
      expectedBuildId: '0'.repeat(40),
      expectedReleaseId: 'v0.4.9'
    };
    const retryStatus = {
      ...status('update-available', priorOperation),
      capabilities: ['codex.machine-tasks.v1', 'runtime.update']
    };
    const result = diagnose({
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }),
      generation: 4,
      runtimeStatus: retryStatus
    });

    expect(result).toMatchObject({
      operation: { id: 'repair-one', state: 'rolled-back' },
      plan: {
        actions: [{
          connectorId: 'linux-stable',
          fromVersion: '0.4.7',
          kind: 'update-connector',
          operation: 'update',
          releaseId: 'v0.4.10',
          toVersion: '0.4.10'
        }]
      },
      ready: true,
      state: 'degraded'
    });
  });

  test('offers an exact constrained retry after a proven pre-install failure', () => {
    const failedOperation = {
      ...operation('failed'),
      expectedBuildId: '1'.repeat(40),
      expectedReleaseId: 'v0.4.10',
      lastFailure: {
        at: '2026-07-24T00:00:01.000Z',
        code: 'download-failed',
        message: 'The connector could not download the signed release.',
        rollbackAvailable: false
      }
    };
    const result = diagnose({
      connector: connector({
        capabilities: ['codex.machine-tasks.v1', 'runtime.update']
      }),
      generation: 4,
      runtimeStatus: {
        ...status('update-available', failedOperation),
        capabilities: ['codex.machine-tasks.v1', 'runtime.update'],
        update: {
          ...status('update-available', failedOperation).update,
          retryEvidence: 'exact-preinstall-download-failure'
        }
      }
    });

    expect(result).toMatchObject({
      operation: { id: 'repair-one', state: 'failed' },
      plan: { actions: [{
        connectorId: 'linux-stable',
        kind: 'update-connector',
        operation: 'update',
        releaseId: 'v0.4.10'
      }] },
      ready: true,
      state: 'degraded'
    });
    for (const rejectedOperation of [
      { ...failedOperation,
        lastFailure: { ...failedOperation.lastFailure, code: 'wrong-reconnect-version' } },
      { ...failedOperation, operation: 'restart' as const }
    ]) {
      const rejected = diagnose({
        runtimeStatus: {
          ...status('update-available', rejectedOperation),
          update: {
            ...status('update-available', rejectedOperation).update,
            retryEvidence: 'exact-preinstall-download-failure'
          }
        }
      });
      expect(rejected.state).toBe('failed');
      expect(rejected.plan).toBeUndefined();
    }
    const missingEvidence = diagnose({
      runtimeStatus: status('update-available', failedOperation)
    });
    expect(missingEvidence.state).toBe('failed');
    expect(missingEvidence.plan).toBeUndefined();
  });

  test('does not retry the same or an unidentified rolled-back update', () => {
    for (const priorOperation of [
      operation('rolled-back'),
      {
        ...operation('rolled-back'),
        expectedBuildId: '0'.repeat(40),
        expectedReleaseId: 'v0.4.10'
      },
      {
        ...operation('rolled-back'),
        expectedBuildId: 'f'.repeat(40),
        expectedFingerprint: { ...runtime, capabilities: [], version: '0.4.10' },
        expectedReleaseId: 'v0.4.9'
      },
      {
        ...operation('rolled-back'),
        expectedBuildId: '0'.repeat(40),
        expectedReleaseId: 'v0.4.9',
        operation: 'restart' as const
      }
    ]) {
      const result = diagnose({
        runtimeStatus: status('update-available', priorOperation)
      });
      expect(result).toMatchObject({
        operation: { id: 'repair-one', state: 'rolled-back' },
        state: 'rolled-back'
      });
      expect(result.plan).toBeUndefined();
    }
  });

  test('requires an exact connector when multiple candidates are equally ready', () => {
    const second = {
      ...connector({ capabilities: ['codex.machine-tasks.v1'] }),
      id: 'windows-stable',
      name: 'Windows Stable'
    };
    const result = evaluateMachineReadiness({
      checkedAt: '2026-07-24T00:00:00.000Z',
      connectors: [
        connector({ capabilities: ['codex.machine-tasks.v1'] }),
        second
      ],
      generationFor: () => 1,
      physicalMachineName: 'os-pc',
      physicalMachines: [{
        connectorIds: ['linux-stable', 'windows-stable'],
        id: 'physical-pc',
        name: 'os-pc'
      }]
    });
    expect(result.state).toBe('ambiguous');
  });
});
