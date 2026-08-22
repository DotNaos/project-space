import { describe, expect, test } from 'bun:test';
import type {
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliHost,
  ProjectCliPlatform
} from '../src/shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '../src/shared/tailscale-inventory-api';
import {
  computeInventoryCounts,
  computePlatformSections,
  filterComputePlatformSections,
  isComputeInventoryStale,
  isSupportedTailnetComputeDevice,
  sortComputePlatformSections
} from '../src/features/project-desktop/components/machines-page-model';

const platform = (id: string, kind: ProjectCliPlatform['kind'], name: string): ProjectCliPlatform => ({
  alias: id,
  id,
  kind,
  name
});

const host = (id: string, platformId: string, state: ProjectCliHost['capabilities']['state'] = 'available'): ProjectCliHost => ({
  alias: id,
  capabilities: { console: [], power: [], state },
  id,
  name: id,
  platformId
});

function environment({
  alias,
  hostId,
  id = alias,
  kind = 'native_linux',
  parentEnvironmentInstanceId,
  platformId = 'local',
  resourceMode = 'dedicated',
  routeState,
  workspaces = [],
  accessSummary,
  hostd = { state: 'unknown' as const },
  resources
}: Partial<ProjectCliEnvironmentInstance> & {
  alias: string;
  routeState?: 'ready' | 'unavailable';
}): ProjectCliEnvironmentInstance {
  return {
    accessRoutes: routeState ? [{ capabilities: [], id: `route-${id}`, lastVerifiedAt: new Date().toISOString(), priority: 1, state: routeState, type: 'ssh_private_network' }] : [],
    accessSummary,
    alias,
    environmentDefinitionId: `definition-${kind}`,
    hostId,
    hostResolution: hostId ? 'manual' : 'not_applicable',
    hostd,
    id,
    kind,
    name: alias,
    parentEnvironmentInstanceId,
    platformId,
    providerLifecycleState: 'unknown',
    reference: `reference-${id}`,
    resourceMode,
    resources,
    workspaceInventory: { state: workspaces.length > 0 ? 'available' : 'unavailable' },
    workspaces
  };
}

function inventory(overrides: Partial<ProjectCliComputeInventory> = {}): ProjectCliComputeInventory {
  const local = platform('local', 'local', 'Local & self-hosted');
  return {
    checkedAt: new Date().toISOString(),
    environmentCatalog: [],
    environmentInstances: [],
    hosts: [],
    inventoryState: 'ready',
    platforms: [local],
    privateNetworks: [],
    schemaVersion: 3,
    violations: [],
    ...overrides
  };
}

function tailnetDevice({
  addresses,
  classification = 'unclassified',
  environmentId,
  id,
  name = id,
  os = 'linux',
  state = 'online'
}: {
  addresses?: string[];
  classification?: TailscaleInventoryDevice['classification'];
  environmentId?: string;
  id: string;
  name?: string;
  os?: string;
  state?: TailscaleInventoryDevice['network']['state'];
}): TailscaleInventoryDevice {
  return {
    addresses: addresses ?? [`100.64.0.${id.length}`],
    classification,
    ...(environmentId ? { environmentId } : {}),
    id,
    name,
    network: {
      checkedAt: '2026-08-21T07:00:00.000Z',
      freshUntil: '2026-08-21T07:01:00.000Z',
      state
    },
    os,
    revision: 1,
    tags: []
  };
}

describe('canonical compute inventory presentation', () => {
  test('keeps provider-managed environments directly under their platform', () => {
    const codespace = environment({
      alias: 'project-space-537-qxpr6qvjp9vf5v',
      kind: 'github_codespace',
      platformId: 'codespaces'
    });
    const sections = computePlatformSections(inventory({
      environmentInstances: [codespace],
      platforms: [platform('codespaces', 'github_codespaces', 'GitHub Codespaces')]
    }));

    expect(sections[0]!.rows.map((row) => [row.kind, row.name, row.depth])).toEqual([
      ['environment', 'project-space-537-qxpr6qvjp9vf5v', 0]
    ]);
    expect(sections[0]!.rows[0]!.hostResolutionLabel).toBe('Provider managed');
    expect(sections[0]!.hostCount).toBe(0);
  });

  test('keeps unassigned Hosts in the one primary inventory', () => {
    const sections = computePlatformSections(inventory({
      hosts: [host('host-a', 'local')]
    }));

    expect(sections[0]!.rows.map((row) => [row.kind, row.name])).toEqual([['host', 'host-a']]);
    expect(computeInventoryCounts(sections)).toEqual({ environments: 0, hosts: 1, tailnet: 0, workspaces: 0 });
  });

  test('folds the same Host, Environment, and Tailnet projection into one machine row', () => {
    const instance = environment({
      alias: 'os-macbook-tail5bb1d7-ts-net',
      hostId: 'os-macbook',
      id: 'environment-macbook',
      kind: 'native_macos'
    });
    const device = tailnetDevice({
      classification: 'environment',
      environmentId: instance.id,
      id: 'device-macbook',
      name: 'os-macbook.tail5bb1d7.ts.net'
    });
    const sections = computePlatformSections(inventory({
      environmentInstances: [instance],
      hosts: [host('os-macbook', 'local', 'unknown')]
    }), [device]);

    expect(sections[0]!.rows).toHaveLength(1);
    expect(sections[0]!.rows[0]).toMatchObject({
      depth: 0,
      host: { id: 'os-macbook' },
      kind: 'environment',
      name: 'os-macbook',
      tailnetDevice: { id: 'device-macbook' }
    });
    expect(computeInventoryCounts(sections)).toEqual({ environments: 1, hosts: 0, tailnet: 1, workspaces: 0 });
  });

  test('does not render legacy fabricated Codespace records as local Hosts', () => {
    const legacyCodespaceHost = {
      ...host('legacy-host', 'local', 'unknown'),
      alias: 'github-codespace-bug-free-space-invention',
      name: 'GitHub Codespace – bug-free-space-invention'
    };
    const sections = computePlatformSections(inventory({
      hosts: [legacyCodespaceHost, host('os-pc', 'local', 'unknown')]
    }));

    expect(sections[0]!.rows.map((row) => row.name)).toEqual(['os-pc']);
  });

  test('renders local Hosts separately from environment status', () => {
    const instances = [
      environment({ alias: 'windows-01', hostId: 'host-a', kind: 'native_windows', resourceMode: 'exclusive' }),
      environment({ alias: 'ubuntu-01', hostId: 'host-a', resourceMode: 'exclusive' })
    ];
    const [section] = computePlatformSections(inventory({
      environmentInstances: instances,
      hosts: [host('host-a', 'local', 'available')]
    }));

    expect(section!.rows.map((row) => [row.kind, row.name, row.depth, row.relationship])).toEqual([
      ['host', 'host-a', 0, undefined],
      ['environment', 'windows-01', 1, 'dual-boot'],
      ['environment', 'ubuntu-01', 1, 'dual-boot']
    ]);
    expect(section!.rows[0]!.hostStatus).toBe('Host reachable');
    expect(section!.rows[1]!.environmentStatus).toBe('Access not reported');
  });

  test('keeps Host capabilities and Environment access provenance on their owning rows', () => {
    const instance = environment({
      alias: 'ubuntu-01', hostId: 'host-a', routeState: 'ready',
      accessSummary: {
        providerKind: 'tailscale', route: 'available',
        ssh: { hostKey: 'verified', projectCli: 'available', readiness: 'available' }
      },
      hostd: { state: 'stale' },
      resources: {
        architecture: 'amd64', cpuCores: 4, memoryTotalBytes: 8_000,
        operatingSystem: 'linux', reportedAt: new Date().toISOString(),
        source: 'hostd', storageTotalBytes: 50_000
      }
    });
    const [section] = computePlatformSections(inventory({
      environmentInstances: [instance],
      hosts: [{
        ...host('host-a', 'local'),
        capabilities: {
          console: [], power: [], state: 'available',
          summary: {
            console: 'available', power: 'available', provider: 'jetkvm',
            reset: 'unavailable', wakeOnLan: 'unavailable'
          }
        }
      }]
    }));

    expect(section!.rows[0]!.hostCapabilities?.provider).toBe('jetkvm');
    expect(section!.rows[1]!.accessSummary?.ssh.hostKey).toBe('verified');
    expect(section!.rows[1]!.resourceSource).toBe('Stale');
  });

  test('nests child environments and retains Workspace Runtime summaries', () => {
    const child = environment({
      alias: 'wsl-ubuntu-01',
      kind: 'wsl',
      parentEnvironmentInstanceId: 'windows-01',
      hostId: 'host-a',
      workspaces: [{ id: 'workspace-1', name: 'Project Space', repository: 'DotNaos/project-space', state: 'active' }]
    });
    const [section] = computePlatformSections(inventory({
      environmentInstances: [environment({ alias: 'windows-01', hostId: 'host-a', kind: 'native_windows' }), child],
      hosts: [host('host-a', 'local')]
    }));

    expect(section!.rows.map((row) => [row.name, row.depth, row.relationship])).toEqual([
      ['host-a', 0, undefined],
      ['windows-01', 1, undefined],
      ['wsl-ubuntu-01', 2, 'nested']
    ]);
    expect(section!.rows[2]!.workspaces[0]!.repository).toBe('DotNaos/project-space');
  });

  test('filters available and attention states without collapsing the hierarchy', () => {
    const sections = computePlatformSections(inventory({
      environmentInstances: [
        environment({ alias: 'ready', hostId: 'host-a', routeState: 'ready' }),
        environment({ alias: 'offline', hostId: 'host-a', routeState: 'unavailable' })
      ],
      hosts: [host('host-a', 'local')]
    }));

    expect(filterComputePlatformSections(sections, 'ready', 'all')[0]!.rows.map((row) => row.name)).toEqual(['host-a', 'ready']);
    expect(filterComputePlatformSections(sections, '', 'available')[0]!.rows.map((row) => row.name)).toEqual(['host-a', 'ready']);
    expect(filterComputePlatformSections(sections, '', 'attention')[0]!.rows.map((row) => row.name)).toEqual(['host-a', 'offline']);
    expect(computeInventoryCounts(filterComputePlatformSections(sections, '', 'attention')))
      .toEqual({ environments: 1, hosts: 1, tailnet: 0, workspaces: 0 });
  });

  test('filters by resource type and sorts online machines first by default', () => {
    const sections = computePlatformSections(inventory({
      hosts: [host('z-offline-host', 'local', 'unknown')]
    }), [
      tailnetDevice({ id: 'z-online', state: 'online' }),
      tailnetDevice({ id: 'a-offline', state: 'offline' })
    ]);

    expect(filterComputePlatformSections(sections, '', 'all', 'host')[0]!.rows.map((row) => row.name))
      .toEqual(['z-offline-host']);
    expect(filterComputePlatformSections(sections, '', 'all', 'tailnet')[0]!.rows.map((row) => row.name))
      .toEqual(['z-online', 'a-offline']);
    expect(sortComputePlatformSections(sections, 'online')[0]!.rows.map((row) => row.name))
      .toEqual(['z-online', 'z-offline-host', 'a-offline']);
    expect(sortComputePlatformSections(sections, 'name')[0]!.rows.map((row) => row.name))
      .toEqual(['a-offline', 'z-offline-host', 'z-online']);
  });

  test('counts mixed inventories and distinguishes stale data', () => {
    const sections = computePlatformSections(inventory({
      environmentInstances: [environment({ alias: 'one', hostId: 'host-a', workspaces: [{ id: 'w', name: 'Workspace', state: 'active' }] })],
      hosts: [host('host-a', 'local')]
    }));
    expect(computeInventoryCounts(sections)).toEqual({ environments: 1, hosts: 1, tailnet: 0, workspaces: 1 });
    expect(isComputeInventoryStale('2026-08-13T11:00:00.000Z', Date.parse('2026-08-13T11:20:00.000Z'))).toBe(true);
    expect(isComputeInventoryStale('2026-08-13T11:19:00.000Z', Date.parse('2026-08-13T11:20:00.000Z'))).toBe(false);
  });

  test('renders every Tailnet classification and connectivity state in the primary inventory', () => {
    const devices = [
      tailnetDevice({ id: 'unclassified', state: 'online' }),
      tailnetDevice({ classification: 'environment', id: 'environment', state: 'offline' }),
      tailnetDevice({ classification: 'deployment_destination', id: 'deployment', state: 'stale' }),
      tailnetDevice({ classification: 'console_endpoint', id: 'console', state: 'unknown' }),
      tailnetDevice({ classification: 'ignored', id: 'ignored', state: 'online' })
    ];
    const sections = computePlatformSections(inventory(), devices);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows.map((row) => [row.kind, row.name, row.status])).toEqual([
      ['tailnet', 'unclassified', 'available'],
      ['tailnet', 'environment', 'attention'],
      ['tailnet', 'deployment', 'attention'],
      ['tailnet', 'console', 'unknown'],
      ['tailnet', 'ignored', 'available']
    ]);
    expect(computeInventoryCounts(sections)).toEqual({ environments: 0, hosts: 0, tailnet: 5, workspaces: 0 });
    expect(filterComputePlatformSections(sections, '100.64.0.12', 'all')[0]!.rows.map((row) => row.name))
      .toEqual(['unclassified']);
    expect(computeInventoryCounts(filterComputePlatformSections(sections, '', 'attention')))
      .toEqual({ environments: 0, hosts: 0, tailnet: 3, workspaces: 0 });
  });

  test('keeps unsupported Tailnet operating systems out of the default Compute inventory', () => {
    const devices = [
      tailnetDevice({ id: 'linux-workstation', os: 'linux' }),
      tailnetDevice({ id: 'mac-workstation', os: 'macOS' }),
      tailnetDevice({ id: 'windows-workstation', os: 'windows' }),
      tailnetDevice({ id: 'phone', os: 'iOS' }),
      tailnetDevice({ id: 'tablet', os: 'android' }),
      tailnetDevice({ id: 'unknown', os: '' })
    ];

    const supported = devices.filter(isSupportedTailnetComputeDevice);
    const sections = computePlatformSections(inventory(), supported);

    expect(sections[0]!.rows.map((row) => row.name)).toEqual([
      'linux-workstation', 'mac-workstation', 'windows-workstation'
    ]);
    expect(devices.filter((device) => !isSupportedTailnetComputeDevice(device)).map((device) => device.id))
      .toEqual(['phone', 'tablet', 'unknown']);
    expect(computeInventoryCounts(sections).tailnet).toBe(3);
  });

  test('reconciles an exact Tailnet projection into one Environment row without hiding online connectivity', () => {
    const projected = environment({ alias: 'os-macbook', hostId: 'host-a', id: 'environment-macbook' });
    const device = tailnetDevice({
      classification: 'environment',
      environmentId: projected.id,
      id: 'device-macbook',
      name: 'os-macbook.tail5bb1d7.ts.net',
      state: 'online'
    });
    const sections = computePlatformSections(inventory({
      environmentInstances: [projected],
      hosts: [host('host-a', 'local')]
    }), [device]);

    expect(sections[0]!.rows.map((row) => row.kind)).toEqual(['host', 'environment']);
    expect(sections[0]!.rows[1]).toMatchObject({
      environmentStatus: 'Access not reported',
      isAvailable: true,
      name: 'os-macbook',
      tailnetDevice: { id: 'device-macbook' }
    });
    expect(computeInventoryCounts(sections)).toEqual({ environments: 1, hosts: 1, tailnet: 1, workspaces: 0 });
  });

  test('groups duplicate Tailnet projections into one machine while preserving every source identity', () => {
    const devices = [
      tailnetDevice({
        addresses: ['100.89.39.17'],
        id: 'runner-old',
        name: 'github-runnervmzvulz.tail5bb1d7.ts.net',
        state: 'stale'
      }),
      tailnetDevice({
        addresses: ['100.70.20.31'],
        id: 'runner-current',
        name: 'github-runnervmzvulz.tail5bb1d7.ts.net',
        state: 'online'
      })
    ];
    const sections = computePlatformSections(inventory(), devices);

    expect(sections[0]!.rows).toHaveLength(1);
    expect(sections[0]!.rows[0]).toMatchObject({
      name: 'github-runnervmzvulz',
      status: 'available',
      tailnetDevices: [{ id: 'runner-current' }, { id: 'runner-old' }]
    });
    expect(computeInventoryCounts(sections).tailnet).toBe(2);

    const oneAddress = filterComputePlatformSections(sections, '100.89.39.17', 'all');
    expect(oneAddress[0]!.rows[0]!.tailnetDevices?.map((device) => device.id)).toEqual(['runner-old']);
    expect(computeInventoryCounts(oneAddress).tailnet).toBe(1);

    const attention = filterComputePlatformSections(sections, '', 'attention');
    expect(attention[0]!.rows[0]!.tailnetDevices?.map((device) => device.id)).toEqual(['runner-old']);
    expect(computeInventoryCounts(attention).tailnet).toBe(1);
  });

  test('merges duplicate local provider projections into one visible platform section', () => {
    const sections = computePlatformSections(inventory({
      environmentInstances: [environment({ alias: 'os-macbook', hostId: 'host-a', platformId: 'local-runtime' })],
      hosts: [host('host-a', 'local-runtime')],
      platforms: [
        platform('local-tailnet', 'local', 'Local & self-hosted'),
        platform('local-runtime', 'local', 'Local & self-hosted')
      ]
    }), [tailnetDevice({ id: 'os-pc', name: 'os-pc.tail5bb1d7.ts.net' })]);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows.map((row) => [row.kind, row.name])).toEqual([
      ['tailnet', 'os-pc'],
      ['host', 'host-a'],
      ['environment', 'os-macbook']
    ]);
    expect(computeInventoryCounts(sections)).toEqual({
      environments: 1,
      hosts: 1,
      tailnet: 1,
      workspaces: 0
    });
  });

  test('does not merge a same-named Tailnet device without an exact Environment projection', () => {
    const projected = environment({ alias: 'os-macbook', hostId: 'host-a', id: 'environment-macbook' });
    const sections = computePlatformSections(inventory({
      environmentInstances: [projected],
      hosts: [host('host-a', 'local')]
    }), [tailnetDevice({ id: 'unrelated', name: 'os-macbook' })]);

    expect(sections[0]!.rows.map((row) => row.kind)).toEqual(['host', 'environment', 'tailnet']);
  });
});
