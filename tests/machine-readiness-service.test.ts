import { describe, expect, test } from 'bun:test';

import {
  createMachineReadinessService,
  MachineReadinessServiceError
} from '../server/machine-readiness/service';
import type { MachineRuntimeStatusResult } from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';

const connector: MachineRecord = {
  connector: {
    capabilities: ['runtime.update'],
    installCommand: 'managed',
    runtime: {
      architecture: 'x64',
      buildId: '0'.repeat(40),
      bundleVersions: { connector: '0.4.7', machineTools: '0.4.7', projectCli: '0.4.7' },
      channel: 'stable',
      instanceId: 'one',
      lastCheckedAt: '2026-07-24T00:00:00.000Z',
      platform: 'linux',
      protocolVersion: '2',
      releaseId: 'v0.4.7',
      source: 'managed',
      version: '0.4.7'
    },
    status: 'online'
  },
  id: 'linux-stable',
  kind: 'connector',
  name: 'Linux Stable',
  network: {},
  roles: [],
  sourcePath: ''
};

function repairableStatus(): MachineRuntimeStatusResult {
  return {
    capabilities: ['runtime.update'],
    machineId: connector.id,
    online: true,
    runtime: connector.connector.runtime,
    update: {
      availableCapabilities: ['codex.runtime.v1', 'runtime.update'],
      availableReleaseId: 'v0.4.10',
      availableVersion: '0.4.10',
      state: 'update-required'
    }
  };
}

describe('machine readiness service', () => {
  test('diagnosis is read-only and exact plans are stale-safe and convergent', async () => {
    let current = repairableStatus();
    const starts: unknown[] = [];
    const service = createMachineReadinessService({
      generationFor: () => current.capabilities.includes('codex.machine-tasks.v1') ? 8 : undefined,
      async inventory() {
        return {
          connectors: [{
            ...connector,
            connector: { ...connector.connector, capabilities: current.capabilities }
          }],
          physicalMachines: [{
            connectorIds: [connector.id],
            id: 'physical-pc',
            name: 'os-pc'
          }]
        };
      },
      async runtimeStatus() {
        return current;
      },
      async startRuntimeOperation(connectorId, request) {
        starts.push({ connectorId, request });
        const operation = {
          createdAt: '2026-07-24T00:00:00.000Z',
          id: 'runtime-operation',
          machineId: connectorId,
          operation: 'update' as const,
          requestedByUserId: 'owner',
          state: 'queued' as const,
          updatedAt: '2026-07-24T00:00:00.000Z'
        };
        current = {
          ...current,
          update: { operation, state: 'updating' }
        };
        return {
          operation,
          status: current
        };
      }
    });
    const actor = { userId: 'owner' };
    const selector = { physicalMachineName: 'os-pc' };
    const diagnosis = await service.diagnose(actor, selector);
    expect(diagnosis.state).toBe('repairable');
    expect(starts).toHaveLength(0);

    await expect(service.fix(actor, {
      ...selector,
      operationId: 'doctor:stale',
      planId: '0'.repeat(64)
    })).rejects.toEqual(expect.objectContaining<Partial<MachineReadinessServiceError>>({
      code: 'stale-plan'
    }));
    expect(starts).toHaveLength(0);

    const started = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:exact',
      planId: diagnosis.plan!.id
    });
    expect(started.state).toBe('repairing');
    expect(starts).toEqual([{
      connectorId: 'linux-stable',
      request: { operation: 'update', releaseId: 'v0.4.10' }
    }]);

    current = {
      ...repairableStatus(),
      capabilities: ['codex.machine-tasks.v1', 'runtime.update'],
      update: { state: 'up-to-date' }
    };
    const repeated = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:exact',
      planId: diagnosis.plan!.id
    });
    expect(repeated.state).toBe('converged');
    expect(repeated.diagnosis.state).toBe('ready');
    expect(starts).toHaveLength(1);
  });

  test('does not call a stale post-dispatch diagnosis repaired', async () => {
    const current = {
      ...repairableStatus(),
      capabilities: ['codex.machine-tasks.v1', 'runtime.update']
    };
    const service = createMachineReadinessService({
      generationFor: () => 8,
      async inventory() {
        return {
          connectors: [{
            ...connector,
            connector: { ...connector.connector, capabilities: current.capabilities }
          }],
          physicalMachines: [{
            connectorIds: [connector.id],
            id: 'physical-pc',
            name: 'os-pc'
          }]
        };
      },
      async runtimeStatus() {
        return current;
      },
      async startRuntimeOperation(connectorId) {
        const operation = {
          createdAt: '2026-07-24T00:00:00.000Z',
          id: 'runtime-operation',
          machineId: connectorId,
          operation: 'update' as const,
          requestedByUserId: 'owner',
          state: 'queued' as const,
          updatedAt: '2026-07-24T00:00:00.000Z'
        };
        return { operation, status: current };
      }
    });
    const actor = { userId: 'owner' };
    const selector = { physicalMachineName: 'os-pc' };
    const diagnosis = await service.diagnose(actor, selector);
    expect(diagnosis.state).toBe('degraded');

    const started = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:exact',
      planId: diagnosis.plan!.id
    });
    expect(started.state).toBe('verification-pending');
    expect(started.diagnosis.state).toBe('degraded');
  });

  test('dispatches only the constrained restart from an exact stale-session plan', async () => {
    let current: MachineRuntimeStatusResult = {
      ...repairableStatus(),
      capabilities: ['codex.machine-tasks.v1', 'runtime.restart'],
      update: { state: 'restart-required' }
    };
    const starts: unknown[] = [];
    const service = createMachineReadinessService({
      generationFor: () => undefined,
      async inventory() {
        return {
          connectors: [{
            ...connector,
            connector: { ...connector.connector, capabilities: current.capabilities }
          }],
          physicalMachines: [{
            connectorIds: [connector.id],
            id: 'physical-pc',
            name: 'os-pc'
          }]
        };
      },
      async runtimeStatus() {
        return current;
      },
      async startRuntimeOperation(connectorId, request) {
        starts.push({ connectorId, request });
        const operation = {
          createdAt: '2026-07-24T00:00:00.000Z',
          id: 'runtime-restart',
          machineId: connectorId,
          operation: 'restart' as const,
          requestedByUserId: 'owner',
          state: 'queued' as const,
          updatedAt: '2026-07-24T00:00:00.000Z'
        };
        current = { ...current, update: { operation, state: 'restarting' } };
        return { operation, status: current };
      }
    });
    const actor = { userId: 'owner' };
    const selector = { physicalMachineName: 'os-pc' };
    const diagnosis = await service.diagnose(actor, selector);
    expect(diagnosis.state).toBe('repairable');

    const started = await service.fix(actor, {
      ...selector,
      operationId: 'doctor:restart',
      planId: diagnosis.plan!.id
    });
    expect(started.state).toBe('repairing');
    expect(starts).toEqual([{
      connectorId: 'linux-stable',
      request: { operation: 'restart' }
    }]);
  });
});
