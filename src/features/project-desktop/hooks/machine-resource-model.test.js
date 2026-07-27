import { describe, expect, it } from 'bun:test';
import {
  markMachineResourcesUnavailable,
  mergeMachineResources,
  preserveMachineResources
} from './machine-resource-model';

function machine(id) {
  return {
    connector: { installCommand: 'project connector install', status: 'online' },
    id,
    kind: 'workstation',
    name: id,
    network: {},
    roles: [],
    sourcePath: 'test'
  };
}

function overview(machines) {
  return {
    machines,
    machinesRepo: { exists: false, path: '' },
    tailscale: {
      connected: false,
      installed: false,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    }
  };
}

function resources(connectorId) {
  const available = { state: 'available', utilizationPercent: 42 };
  return {
    apiVersion: 1,
    connectorId,
    context: { id: connectorId },
    machineId: connectorId,
    machineName: connectorId,
    metrics: {
      cpu: available,
      disk: available,
      gpu: { state: 'unsupported' },
      memory: available
    },
    receivedAt: '2026-07-25T12:00:00.000Z',
    sampledAt: '2026-07-25T12:00:00.000Z',
    state: 'live'
  };
}

describe('machine resource overview model', () => {
  it('attaches only the matching connector snapshot', () => {
    const result = mergeMachineResources(overview([machine('one'), machine('two')]), [
      resources('two')
    ]);

    expect(result.machines[0]?.resources).toBeUndefined();
    expect(result.machines[1]?.resources?.metrics.cpu.utilizationPercent).toBe(42);
  });

  it('preserves the latest snapshot while the connector overview refreshes', () => {
    const current = mergeMachineResources(overview([machine('one')]), [resources('one')]);
    const result = preserveMachineResources(overview([machine('one')]), current);

    expect(result.machines[0]?.resources?.state).toBe('live');
  });

  it('reports an initial request failure instead of checking forever', () => {
    const result = markMachineResourcesUnavailable(
      overview([machine('one')]),
      Date.parse('2026-07-25T12:00:00.000Z')
    );

    expect(result.machines[0]?.resources?.state).toBe('failed');
    expect(result.machines[0]?.resources?.metrics.cpu.state).toBe('failed');
  });

  it('ages an old successful snapshot to stale after request failures', () => {
    const current = mergeMachineResources(overview([machine('one')]), [resources('one')]);
    const result = markMachineResourcesUnavailable(
      current,
      Date.parse('2026-07-25T12:00:16.000Z')
    );

    expect(result.machines[0]?.resources?.state).toBe('stale');
    expect(result.machines[0]?.resources?.metrics.cpu.utilizationPercent).toBe(42);
  });
});
