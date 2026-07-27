import { describe, expect, test } from 'bun:test';

import { createMachineReadinessService } from '../server/machine-readiness/service';
import { evaluateMachineReadiness } from '../server/machine-readiness/model';
import type { CodexDaemonEvidence } from '../src/shared/codex-daemon-api';
import type { MachineRecord } from '../src/shared/project-space-api';

const checkedAt = '2026-07-27T00:00:00.000Z';
const stopped: CodexDaemonEvidence = {
  authenticated: false,
  checkedAt,
  cliVersion: '0.146.0',
  compatible: false,
  installed: true,
  paired: false,
  reachable: false,
  remoteControlEnabled: false,
  remoteControlState: 'unknown',
  running: false,
  state: 'stopped'
};
const ready: CodexDaemonEvidence = {
  ...stopped,
  appServerVersion: '0.146.0',
  authenticated: true,
  compatible: true,
  environmentId: 'env_os_pc',
  paired: true,
  reachable: true,
  remoteControlEnabled: true,
  remoteControlState: 'connected',
  running: true,
  state: 'ready'
};

function connector(daemon: CodexDaemonEvidence): MachineRecord {
  return {
    connector: {
      capabilities: [
        'codex.app-server-daemon.v1',
        ...(daemon.state === 'ready' ? ['codex.machine-tasks.v1'] : [])
      ],
      daemon,
      installCommand: 'managed',
      status: 'online'
    },
    id: 'remote-control:env_os_pc',
    kind: 'connector',
    name: 'os-pc WSL',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('Project Doctor managed Codex daemon contract', () => {
  test('distinguishes shared daemon readiness from connector readiness', () => {
    const result = evaluateMachineReadiness({
      checkedAt,
      connectors: [connector(stopped)],
      generationFor: () => 3,
      physicalMachineName: 'os-pc',
      physicalMachines: [{
        connectorIds: ['remote-control:env_os_pc'],
        id: 'os-pc',
        name: 'os-pc'
      }]
    });
    expect(result.state).toBe('repairable');
    expect(result.ready).toBe(false);
    expect(result.checks[0]?.daemon).toEqual(stopped);
    expect(result.plan?.actions).toEqual([
      expect.objectContaining({
        kind: 'ensure-codex-daemon',
        operation: 'ensure'
      })
    ]);
  });

  test('does not offer daemon mutation to an unmanaged source connector', () => {
    const source = connector(stopped);
    source.connector.capabilities = [];
    const result = evaluateMachineReadiness({
      checkedAt,
      connectors: [source],
      generationFor: () => 3,
      physicalMachineName: 'os-pc',
      physicalMachines: [{
        connectorIds: ['remote-control:env_os_pc'],
        id: 'os-pc',
        name: 'os-pc'
      }]
    });

    expect(result.plan).toBeUndefined();
    expect(result.state).toBe('unsupported');
  });

  test('dispatches only the confirmed exact daemon operation id and verifies convergence', async () => {
    const dispatched: unknown[] = [];
    const service = createMachineReadinessService({
      generationFor: () => 3,
      async inventory() {
        return {
          connectors: [connector(stopped)],
          physicalMachines: [{
            connectorIds: ['remote-control:env_os_pc'],
            id: 'os-pc',
            name: 'os-pc'
          }]
        };
      },
      async runtimeStatus() {
        return {
          capabilities: ['codex.app-server-daemon.v1', 'codex.machine-tasks.v1'],
          machineId: 'remote-control:env_os_pc',
          online: true,
          update: { state: 'up-to-date' }
        };
      },
      async startDaemonOperation(connectorId, operation, operationId) {
        dispatched.push({ connectorId, operation, operationId });
        return {
          evidence: { ...ready, checkedAt: new Date().toISOString() },
          operation,
          operationId,
          state: 'completed'
        };
      },
      async startRuntimeOperation() {
        throw new Error('runtime maintenance must not be used for daemon repair');
      }
    });
    const actor = { userId: 'owner' };
    const selector = { physicalMachineName: 'os-pc' };
    const diagnosis = await service.diagnose(actor, selector);
    const fixed = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:daemon:exact',
      planId: diagnosis.plan!.id
    });

    expect(dispatched).toEqual([{
      connectorId: 'remote-control:env_os_pc',
      operation: 'ensure',
      operationId: 'doctor:daemon:exact'
    }, {
      connectorId: 'remote-control:env_os_pc',
      operation: 'status',
      operationId: expect.stringMatching(/^doctor:daemon-status:[a-f0-9]{32}$/)
    }]);
    expect(fixed.state).toBe('repaired');
    expect(fixed.diagnosis.state).toBe('ready');
    expect(fixed.daemonOperation?.evidence.environmentId).toBe('env_os_pc');
  });

  test('does not report repaired from replayed daemon evidence older than diagnosis', async () => {
    const staleReady = {
      ...ready,
      checkedAt: new Date(Date.now() - 60_000).toISOString()
    };
    const currentStopped = {
      ...stopped,
      checkedAt: new Date(Date.now() - 1_000).toISOString()
    };
    const service = createMachineReadinessService({
      generationFor: () => 3,
      async inventory() {
        return {
          connectors: [connector(currentStopped)],
          physicalMachines: [{
            connectorIds: ['remote-control:env_os_pc'],
            id: 'os-pc',
            name: 'os-pc'
          }]
        };
      },
      async runtimeStatus() {
        return {
          capabilities: ['codex.app-server-daemon.v1'],
          machineId: 'remote-control:env_os_pc',
          online: true,
          update: { state: 'up-to-date' }
        };
      },
      async startDaemonOperation(_connectorId, operation, operationId) {
        if (operation === 'status') {
          return {
            evidence: { ...currentStopped, checkedAt: new Date().toISOString() },
            operation,
            operationId,
            state: 'blocked'
          };
        }
        return { evidence: staleReady, operation, operationId, state: 'completed' };
      },
      async startRuntimeOperation() {
        throw new Error('runtime maintenance must not be used for daemon repair');
      }
    });
    const actor = { userId: 'owner' };
    const selector = { physicalMachineName: 'os-pc' };
    const diagnosis = await service.diagnose(actor, selector);
    const fixed = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:daemon:replayed',
      planId: diagnosis.plan!.id
    });

    expect(fixed.state).toBe('verification-pending');
    expect(fixed.diagnosis.state).toBe('repairable');
  });
});
