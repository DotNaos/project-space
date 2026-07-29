import { describe, expect, test } from 'bun:test';

import {
  createMachineDirectoryService,
  type MachineDirectoryIdentity
} from '../server/machine-directory/service';
import type { CodexSessionListResult } from '../src/shared/codex-sessions-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../src/shared/project-space-api';

const checkedAt = '2026-07-28T16:00:00.000Z';
const physicalMachines: PhysicalMachineRecord[] = [
  {
    connectorIds: ['connector-wsl', 'connector-windows'],
    id: '11111111-1111-4111-8111-111111111111',
    name: 'os-pc'
  },
  {
    connectorIds: ['connector-mac'],
    id: '22222222-2222-4222-8222-222222222222',
    name: 'os-macbook'
  }
];
const identities: MachineDirectoryIdentity[] = [
  {
    architecture: 'amd64',
    hostname: 'os-pc',
    id: 'connector-windows',
    lastSeenAt: '2026-07-28T15:59:00.000Z',
    name: 'os-pc Windows',
    operatingSystem: 'windows'
  },
  {
    architecture: 'amd64',
    hostname: 'os-pc',
    id: 'connector-wsl',
    lastSeenAt: '2026-07-28T15:58:00.000Z',
    name: 'os-pc WSL',
    operatingSystem: 'linux'
  },
  {
    architecture: 'arm64',
    hostname: 'os-macbook',
    id: 'connector-mac',
    lastSeenAt: '2026-07-28T15:57:00.000Z',
    name: 'os-macbook',
    operatingSystem: 'darwin'
  }
];

function connector(
  id: string,
  status: MachineRecord['connector']['status'],
  daemonState?: NonNullable<MachineRecord['connector']['daemon']>['state']
): MachineRecord {
  return {
    connector: {
      ...(daemonState
        ? {
            daemon: {
              checkedAt,
              operationId: `status:${id}`,
              platform: 'native',
              state: daemonState
            }
          }
        : {}),
      installCommand: 'project connector install',
      lastSeen: '2026-07-28T15:59:30.000Z',
      status
    },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function sessionInventory(
  connectorId: string,
  title: string,
  inventoryState: 'live' | 'stale' = 'live'
): CodexSessionListResult {
  return {
    checkedAt,
    inventoryState,
    machine: {
      id: connectorId,
      name: connectorId,
      online: inventoryState === 'live'
    },
    sessions: [{
      archived: false,
      cwd: '/repo/project-space',
      id: connectorId === 'connector-mac'
        ? '019fa95f-2e5d-78c1-b360-b2a2d16f45cd'
        : '019fa933-ef3f-75a1-b23b-ad132d87bf72',
      lastActivityAt: '2026-07-28T15:50:00.000Z',
      loadedByProjectSpace: inventoryState === 'live',
      machineId: connectorId,
      machineName: connectorId,
      project: 'DotNaos/project-space',
      status: inventoryState === 'live' ? 'idle' : 'offline',
      title
    }]
  };
}

function service() {
  return createMachineDirectoryService({
    now: () => new Date(checkedAt),
    async inventory() {
      return {
        connectors: [
          connector('connector-windows', 'online', 'ready'),
          connector('connector-wsl', 'offline', 'stopped'),
          connector('connector-mac', 'online', 'ready')
        ],
        identities,
        physicalMachines
      };
    },
    async listCodexSessions(_userId, connectorId) {
      if (connectorId === 'connector-wsl') {
        throw new Error('connector did not answer');
      }
      return sessionInventory(
        connectorId,
        connectorId === 'connector-mac' ? 'Mac task' : 'PC task'
      );
    },
    async probe(hostname) {
      return hostname === 'os-pc'
        ? {
            ssh: { checkedAt, lastSeenAt: checkedAt, state: 'available' as const },
            tailscale: { checkedAt, lastSeenAt: checkedAt, state: 'reachable' as const }
          }
        : {
            ssh: { checkedAt, state: 'unknown' as const },
            tailscale: { checkedAt, state: 'unreachable' as const }
          };
    }
  });
}

describe('machine directory service', () => {
  test('keeps Tailscale, SSH, connector, and App Server evidence separate', async () => {
    const result = await service().listMachines({ userId: 'owner' });

    expect(result.schemaVersion).toBe(1);
    expect(result.machines.map((machine) => machine.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111'
    ]);
    expect(result.machines[1]).toMatchObject({
      codexAppServer: { state: 'available' },
      connector: {
        installations: [
          { id: 'connector-windows', state: 'ready' },
          { id: 'connector-wsl', state: 'unavailable' }
        ],
        state: 'degraded'
      },
      enrollment: {
        lastSeenAt: '2026-07-28T15:59:00.000Z',
        state: 'enrolled'
      },
      platform: {
        architectures: ['amd64'],
        operatingSystems: ['linux', 'windows']
      },
      ssh: { state: 'available' },
      tailscale: { state: 'reachable' }
    });
    expect(JSON.stringify(result)).not.toContain('power');
  });

  test('retains durable enrollment evidence and the newest ready App Server observation', async () => {
    const older = connector('connector-windows', 'online', 'ready');
    const newer = connector('connector-wsl', 'online', 'ready');
    older.connector.daemon!.checkedAt = '2026-07-28T15:50:00.000Z';
    newer.connector.daemon!.checkedAt = '2026-07-28T15:55:00.000Z';
    const observed = createMachineDirectoryService({
      now: () => new Date(checkedAt),
      async inventory() {
        return {
          connectors: [older, newer],
          identities: identities.slice(0, 2),
          physicalMachines: physicalMachines.slice(0, 1)
        };
      },
      async listCodexSessions() {
        throw new Error('unused');
      },
      async probe() {
        throw new Error('Tailscale unavailable');
      }
    });

    const result = await observed.listMachines({ userId: 'owner' });
    expect(result.machines[0]).toMatchObject({
      codexAppServer: {
        lastSeenAt: '2026-07-28T15:55:00.000Z',
        state: 'available'
      },
      enrollment: {
        lastSeenAt: '2026-07-28T15:59:00.000Z',
        state: 'enrolled'
      },
      ssh: { state: 'unknown' },
      tailscale: { state: 'unknown' }
    });
  });

  test('resolves SSH only from one approved enrolled hostname', async () => {
    await expect(service().resolveSsh(
      { userId: 'owner' },
      '11111111-1111-4111-8111-111111111111'
    )).resolves.toMatchObject({
      machine: { name: 'os-pc' },
      target: 'os-pc'
    });
    await expect(service().resolveSsh(
      { userId: 'owner' },
      '22222222-2222-4222-8222-222222222222'
    )).rejects.toMatchObject({ code: 'ssh_unavailable' });
  });

  test('returns healthy threads when one connector inventory fails', async () => {
    const result = await service().listCodexThreads(
      { userId: 'owner' },
      { includeArchived: false, machineName: 'os-pc', search: 'task' }
    );

    expect(result.partial).toBe(true);
    expect(result.threads).toEqual([
      expect.objectContaining({
        connectorId: 'connector-windows',
        machine: {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'os-pc'
        },
        title: 'PC task'
      })
    ]);
    expect(result.hosts).toEqual([
      expect.objectContaining({
        connectorId: 'connector-windows',
        inventoryState: 'live'
      }),
      expect.objectContaining({
        connectorId: 'connector-wsl',
        inventoryState: 'unavailable'
      })
    ]);
  });

  test('does not expose another account inventory', async () => {
    const isolated = createMachineDirectoryService({
      now: () => new Date(checkedAt),
      async inventory(userId) {
        return userId === 'owner'
          ? { connectors: [], identities, physicalMachines }
          : { connectors: [], identities: [], physicalMachines: [] };
      },
      async listCodexSessions() {
        throw new Error('must not dispatch');
      },
      async probe() {
        throw new Error('must not probe');
      }
    });

    expect((await isolated.listMachines({ userId: 'other' })).machines).toEqual([]);
    expect((await isolated.listCodexThreads(
      { userId: 'other' },
      { includeArchived: true }
    )).threads).toEqual([]);
  });
});
