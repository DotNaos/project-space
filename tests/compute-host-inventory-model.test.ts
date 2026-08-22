import { describe, expect, test } from 'bun:test';
import type { ProjectCliComputeInventory } from '../src/shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '../src/shared/tailscale-inventory-api';
import {
  buildComputeHostInventory,
  filterComputeHostInventory,
  sortComputeHostInventory
} from '../src/features/project-desktop/components/compute-host-inventory-model';

const checkedAt = '2026-08-21T12:00:00.000Z';

function device(
  id: string,
  name: string,
  state: TailscaleInventoryDevice['network']['state'],
  options: { hostId?: string; os?: string } = {}
): TailscaleInventoryDevice {
  return {
    addresses: [`100.64.0.${id.length}`],
    classification: 'unclassified',
    hostAssignmentRevision: options.hostId ? 1 : 0,
    ...(options.hostId ? { hostId: options.hostId } : {}),
    id,
    name,
    network: {
      checkedAt,
      freshUntil: '2026-08-21T12:01:00.000Z',
      state
    },
    os: options.os ?? 'linux',
    revision: 0,
    tags: []
  };
}

function inventory(): ProjectCliComputeInventory {
  return {
    checkedAt,
    environmentCatalog: [],
    environmentInstances: [
      {
        alias: 'space-one',
        hostd: { state: 'not_reported' },
        id: 'codespace-one',
        kind: 'github_codespace',
        name: 'space-one',
        platformId: 'github',
        resourceMode: 'dedicated',
        workspaces: []
      } as never,
      {
        alias: 'legacy-environment',
        hostd: { state: 'not_reported' },
        id: 'legacy-environment',
        kind: 'native_linux',
        name: 'legacy-environment',
        platformId: 'local',
        resourceMode: 'dedicated',
        workspaces: []
      } as never
    ],
    hosts: [
      { alias: 'macbook', id: 'host-mac', name: 'MacBook', platformId: 'local' } as never,
      { alias: 'empty', id: 'host-empty', name: 'Legacy empty Host', platformId: 'local' } as never
    ],
    inventoryState: 'ready',
    platforms: [
      { alias: 'github', id: 'github', kind: 'github_codespaces', name: 'GitHub Codespaces' },
      { alias: 'local', id: 'local', kind: 'local', name: 'Local & self-hosted' }
    ],
    privateNetworks: [],
    schemaVersion: 3,
    violations: []
  };
}

describe('Tailnet device to Host inventory model', () => {
  test('uses manual Host assignments and never promotes legacy Environments into Hosts', () => {
    const result = buildComputeHostInventory(inventory(), [
      device('assigned', 'os-macbook.tail5bb1d7.ts.net', 'online', { hostId: 'host-mac', os: 'darwin' }),
      device('available', 'os-vps-1', 'offline'),
      device('excluded', 'oli-iphone', 'online', { os: 'iOS' })
    ]);

    expect(result.hosts).toEqual([
      expect.objectContaining({
        id: 'host-mac',
        name: 'MacBook',
        devices: [expect.objectContaining({ id: 'assigned', name: 'os-macbook' })]
      })
    ]);
    expect(result.available.map(({ id }) => id)).toEqual(['available']);
    expect(result.excluded.map(({ id }) => id)).toEqual(['excluded']);
    expect(result.codespaces.map(({ id }) => id)).toEqual(['codespace-one']);
    expect(result.hosts.some(({ id }) => id === 'host-empty')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/legacy-environment|Unclassified|Environment/);
  });

  test('keeps connectivity separate while filtering one coherent visible inventory', () => {
    const model = buildComputeHostInventory(inventory(), [
      device('online', 'online-device', 'online', { hostId: 'host-mac' }),
      device('offline', 'offline-device', 'offline', { hostId: 'host-mac' }),
      device('available', 'available-device', 'stale')
    ]);

    const attention = filterComputeHostInventory(model, {
      query: '',
      section: 'all',
      status: 'attention'
    });
    expect(attention.hosts[0]?.devices.map(({ id }) => id)).toEqual(['offline']);
    expect(attention.available.map(({ id }) => id)).toEqual(['available']);
    expect(attention.codespaces).toEqual([]);

    const searched = filterComputeHostInventory(model, {
      query: 'online-device',
      section: 'all',
      status: 'all'
    });
    expect(searched.hosts[0]?.devices.map(({ id }) => id)).toEqual(['online']);
    expect(searched.available).toEqual([]);
  });

  test('sorts Host groups and devices online first without changing their assignment', () => {
    const source = inventory();
    source.hosts.push({ alias: 'server', id: 'host-server', name: 'Server', platformId: 'local' } as never);
    const model = buildComputeHostInventory(source, [
      device('mac-offline', 'mac-offline', 'offline', { hostId: 'host-mac' }),
      device('server-online', 'server-online', 'online', { hostId: 'host-server' }),
      device('available-offline', 'z-device', 'offline'),
      device('available-online', 'a-device', 'online')
    ]);

    const sorted = sortComputeHostInventory(model, 'online');
    expect(sorted.hosts.map(({ id }) => id)).toEqual(['host-server', 'host-mac']);
    expect(sorted.available.map(({ id }) => id)).toEqual(['available-online', 'available-offline']);
  });
});
