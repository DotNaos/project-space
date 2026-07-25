import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CpuInfo } from 'node:os';

import { afterEach, describe, expect, test } from 'bun:test';

import { createMachineResourceCollector } from '../server/machine-resource-collector';
import {
  clearMachineResourceSnapshots,
  latestMachineResourceSnapshot,
  registerMachineResourceSnapshot
} from '../server/machine-resource-store';
import { isConnectorHubMessage } from '../server/connector-command-protocol';
import { createConfiguredMachineResourcesHandler } from '../server/machine-resources-http';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import { createProjectSpaceServer } from '../server/project-space-http';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import {
  MACHINE_RESOURCES_API_VERSION,
  isMachineResourceSnapshot,
  type MachineResourceSnapshot,
  type MachineResourcesResult
} from '../src/shared/machine-resources-api';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;
const originalRegistrationToken = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  clearMachineResourceSnapshots();
  restore('PROJECT_SPACE_AUTH_DISABLED', originalAuthDisabled);
  restore('PROJECT_CONNECTOR_REGISTRATION_TOKEN', originalRegistrationToken);
});

function cpu(idle: number, user: number): CpuInfo {
  return {
    model: 'test',
    speed: 1,
    times: { idle, irq: 0, nice: 0, sys: 0, user }
  };
}

function snapshot(
  connectorId: string,
  gpuState: 'available' | 'failed' | 'unsupported' = 'unsupported'
): MachineResourceSnapshot {
  return {
    apiVersion: MACHINE_RESOURCES_API_VERSION,
    connectorId,
    metrics: {
      cpu: { state: 'available', utilizationPercent: 25 },
      disk: {
        state: 'available',
        totalBytes: 1_000,
        usedBytes: 500,
        utilizationPercent: 50
      },
      gpu: gpuState === 'available'
        ? { state: 'available', utilizationPercent: 10 }
        : { state: gpuState, message: 'GPU unavailable.' },
      memory: {
        state: 'available',
        totalBytes: 1_000,
        usedBytes: 750,
        utilizationPercent: 75
      }
    },
    sampledAt: new Date().toISOString()
  };
}

function resourceBackend(machineId: string) {
  return {
    async getConnectorOverview() {
      return {
        machines: [{
          connector: {
            installCommand: 'project-space-connector',
            status: 'online'
          },
          environment: { kind: 'linux', label: 'Ubuntu' },
          id: machineId,
          kind: 'connector',
          name: 'Resource machine',
          network: {},
          roles: ['connector'],
          sourcePath: 'connector-hub'
        }],
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
  } as Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
}

describe('machine resource collection', () => {
  test('collects CPU, memory, disk, and weighted NVIDIA GPU utilization', async () => {
    let cpuRead = 0;
    const collect = createMachineResourceCollector({
      cpuInfo: () => cpuRead++ === 0 ? [cpu(80, 20)] : [cpu(140, 60)],
      executeFile: async () => ({ stdout: '50, 25, 100\n60, 50, 100\n' }),
      freeMemory: () => 250,
      homeDirectory: () => '/home/test',
      pause: async () => {},
      statFileSystem: async () => ({ bavail: 25, blocks: 100, bsize: 10 }),
      totalMemory: () => 1_000
    });

    const result = await collect('resource-machine');

    expect(result.metrics.cpu.utilizationPercent).toBe(40);
    expect(result.metrics.memory).toMatchObject({
      state: 'available',
      totalBytes: 1_000,
      usedBytes: 750,
      utilizationPercent: 75
    });
    expect(result.metrics.disk).toMatchObject({
      state: 'available',
      totalBytes: 1_000,
      usedBytes: 750,
      utilizationPercent: 75
    });
    expect(result.metrics.gpu).toMatchObject({
      state: 'available',
      totalBytes: 200 * 1024 * 1024,
      usedBytes: 75 * 1024 * 1024,
      utilizationPercent: 55
    });
    expect(isMachineResourceSnapshot(result)).toBe(true);
  });

  test('reports an absent NVIDIA tool as unsupported without inventing zero usage', async () => {
    const collect = createMachineResourceCollector({
      cpuInfo: () => [cpu(50, 50)],
      executeFile: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      freeMemory: () => 500,
      pause: async () => {},
      statFileSystem: async () => ({ bavail: 50, blocks: 100, bsize: 10 }),
      totalMemory: () => 1_000
    });

    const result = await collect('resource-machine');

    expect(result.metrics.gpu).toEqual({
      message: 'GPU utilization is not supported on this machine.',
      state: 'unsupported'
    });
    expect(result.metrics.gpu.utilizationPercent).toBeUndefined();
  });

  test('rejects malformed telemetry and stores isolated latest-snapshot copies', () => {
    const value = snapshot('resource-machine');
    expect(isConnectorHubMessage({
      payload: value,
      type: 'connector.resources'
    })).toBe(true);
    expect(isConnectorHubMessage({
      payload: {
        ...value,
        metrics: {
          ...value.metrics,
          cpu: { state: 'available' }
        }
      },
      type: 'connector.resources'
    })).toBe(false);

    registerMachineResourceSnapshot('resource-machine', value);
    value.metrics.cpu.utilizationPercent = 99;
    const first = latestMachineResourceSnapshot('resource-machine')!;
    expect(first.snapshot.metrics.cpu.utilizationPercent).toBe(25);
    first.snapshot.metrics.cpu.utilizationPercent = 88;
    expect(
      latestMachineResourceSnapshot('resource-machine')!.snapshot.metrics.cpu.utilizationPercent
    ).toBe(25);
  });
});

describe('machine resource HTTP API', () => {
  test('accepts a machine credential and returns its authorized context snapshot', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    const machineId = 'credential-machine';
    registerMachineResourceSnapshot(machineId, snapshot(machineId));
    const handler = createConfiguredMachineResourcesHandler({
      backend: resourceBackend(machineId),
      machineConnection: {
        async resolveMachineCredentialIdentity(token, requestedMachineId) {
          return token === 'machine-secret' && requestedMachineId === machineId
            ? {
                hostId: 'physical-host',
                machineId,
                userId: 'machine-owner'
              }
            : null;
        }
      }
    });
    const server = createServer((request, response) => {
      void handler(
        request,
        response,
        new URL(request.url ?? '/', 'http://127.0.0.1')
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const response = await fetch(`${origin}/api/machine-resources`, {
        headers: {
          Authorization: 'Bearer machine-secret',
          'X-Project-Machine-Id': machineId
        }
      });
      expect(response.status).toBe(200);
      const result = await response.json() as MachineResourcesResult;
      expect(result.machines).toHaveLength(1);
      expect(result.machines[0]).toMatchObject({
        connectorId: machineId,
        context: { id: machineId, label: 'Ubuntu · Stable' },
        machineId,
        state: 'live'
      });

      const unauthenticated = await fetch(`${origin}/api/machine-resources`);
      expect(unauthenticated.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('publishes current connector snapshots over the authenticated websocket', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'resource-test-token';
    const machineId = 'websocket-resource-machine';
    const hub = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });
    const backend = {
      async getConnectorProjectRegistry() {
        return {
          checkedAt: new Date().toISOString(),
          connector: { machineId, machineName: 'Websocket resource machine' },
          discovery: {
            groups: [],
            projects: [],
            rootItems: [],
            rootPath: '/tmp',
            structureViolations: []
          }
        };
      }
    } as unknown as ProjectSpaceBackend;
    const bridge = startProjectConnectorWebSocket({
      backend,
      collectResources: async () => snapshot(machineId),
      hubUrl: `${hub.origin.replace(/^http/, 'ws')}/api/connectors/socket`,
      reconnectDelayMs: 20,
      resourceIntervalMs: 20
    });

    try {
      let result: MachineResourcesResult | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${hub.origin}/api/machine-resources`);
        if (response.ok) {
          const current = await response.json() as MachineResourcesResult;
          if (current.machines.some((machine) => machine.connectorId === machineId)) {
            result = current;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(result?.machines.find((machine) => machine.connectorId === machineId))
        .toMatchObject({
          machineId,
          metrics: { cpu: { state: 'available', utilizationPercent: 25 } },
          state: 'live'
        });
    } finally {
      bridge.close();
      await hub.close();
    }
  });

  test('distinguishes stale, offline, and unsupported contexts without zero values', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const staleId = 'stale-machine';
    const offlineId = 'offline-machine';
    const unsupportedId = 'unsupported-machine';
    registerMachineResourceSnapshot(
      staleId,
      snapshot(staleId),
      new Date(Date.now() - 60_000).toISOString()
    );
    registerMachineResourceSnapshot(offlineId, snapshot(offlineId));
    const backend = {
      async getConnectorOverview() {
        return {
          machines: [
            [staleId, 'online'],
            [offlineId, 'offline'],
            [unsupportedId, 'online']
          ].map(([id, status]) => ({
            connector: {
              installCommand: 'project-space-connector',
              status
            },
            id,
            kind: 'connector',
            name: id,
            network: {},
            roles: ['connector'],
            sourcePath: 'connector-hub'
          })),
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
    } as Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
    const handler = createConfiguredMachineResourcesHandler({ backend });
    const server = createServer((request, response) => {
      void handler(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await fetch(`${origin}/api/machine-resources`)
        .then((response) => response.json()) as MachineResourcesResult;
      const states = Object.fromEntries(
        result.machines.map((machine) => [machine.machineId, machine.state])
      );
      expect(states).toEqual({
        [offlineId]: 'offline',
        [staleId]: 'stale',
        [unsupportedId]: 'unsupported'
      });
      const unsupported = result.machines.find(
        (machine) => machine.machineId === unsupportedId
      )!;
      expect(unsupported.metrics.cpu.utilizationPercent).toBeUndefined();
      expect(unsupported.sampledAt).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
