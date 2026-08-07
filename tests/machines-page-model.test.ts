import { describe, expect, test } from 'bun:test';
import type { MachineRecord, PhysicalMachineRecord } from '../src/shared/project-space-api';
import type {
  ComputeEnvironmentRecord,
  ComputeHostRecord,
  ComputePlatformRecord,
  ConnectorEnvironmentAssociation,
  DerivedIdentityKey,
  EnvironmentHostAssociation,
  ResourceProfile
} from '../src/shared/compute-environment-api';
import { groupComputeInventory } from '../src/shared/compute-environment-api';
import { groupSettingsMachines } from '../src/features/project-desktop/components/settings-machine-group-model';
import {
  computePlatformSections,
  filterComputePlatformSections,
  filterMachineRows,
  machineListRows,
  machineRowSubtitle
} from '../src/features/project-desktop/components/machines-page-model';

function machine({
  id,
  name = id,
  platform = 'linux',
  status = 'online'
}: {
  id: string;
  name?: string;
  platform?: 'darwin' | 'linux' | 'windows';
  status?: MachineRecord['connector']['status'];
}): MachineRecord {
  return {
    connector: {
      installCommand: 'project connector install',
      runtime: {
        architecture: 'arm64',
        buildId: '0'.repeat(40),
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel: 'stable',
        instanceId: `instance-${id}`,
        lastCheckedAt: '2026-08-07T00:00:00.000Z',
        platform,
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: 'managed',
        version: '1.0.0'
      },
      status
    },
    id,
    kind: 'connector',
    name,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function physicalMachine(id: string, connectorIds: string[]): PhysicalMachineRecord {
  return { connectorIds, id, name: id };
}

function rowsFor(
  connectors: MachineRecord[],
  physicalMachines: PhysicalMachineRecord[] = []
) {
  return machineListRows(groupSettingsMachines({ connectors, physicalMachines }));
}

function instancesById(connectors: MachineRecord[]) {
  const grouping = groupSettingsMachines({ connectors, physicalMachines: [] });
  return new Map(grouping.unscopedInstances.map((instance) => [instance.id, instance] as const));
}

function identity(key: string): DerivedIdentityKey {
  return { key, version: 1 };
}

function platform(id: string): ComputePlatformRecord {
  return { id, kind: 'local', name: id };
}

function host(id: string, platformId: string, resources?: ResourceProfile): ComputeHostRecord {
  return {
    id,
    identity: identity(`host-${id}`),
    name: id,
    platformId,
    ...(resources ? { resources } : {})
  };
}

function environment({
  hostId,
  id,
  parentEnvironmentId,
  platformId,
  resources
}: {
  hostId?: string;
  id: string;
  parentEnvironmentId?: string;
  platformId: string;
  resources?: ResourceProfile;
}): ComputeEnvironmentRecord {
  const hostAssociation: EnvironmentHostAssociation = hostId
    ? { evidence: 'provider', hostId, resolution: 'verified' }
    : { evidence: 'none', resolution: 'not_applicable' };
  return {
    hostAssociation,
    id,
    identity: identity(`env-${id}`),
    kind: 'native_macos',
    name: id,
    platformId,
    resourceMode: 'dedicated',
    ...(parentEnvironmentId ? { parentEnvironmentId } : {}),
    ...(resources ? { resources } : {})
  };
}

function connectorAssociation(
  connectorId: string,
  environmentId: string
): ConnectorEnvironmentAssociation {
  return { associatedAt: '2026-08-07T00:00:00.000Z', connectorId, environmentId };
}

const resources: ResourceProfile = {
  architecture: 'arm64',
  cpu: { cores: 8 },
  memory: { totalBytes: 16 * 1_024 ** 3 },
  operatingSystem: 'macOS',
  reportedAt: '2026-08-07T00:00:00.000Z',
  source: 'connector',
  storage: { totalBytes: 512 * 1_024 ** 3 }
};

describe('machineListRows', () => {
  test('renders one row per physical machine and per ungrouped connector', () => {
    const rows = rowsFor(
      [
        machine({ id: 'connector-a', platform: 'darwin' }),
        machine({ id: 'connector-b', platform: 'linux', status: 'offline' }),
        machine({ id: 'lonely-connector', name: 'os-yoga', status: 'offline' })
      ],
      [physicalMachine('os-macbook', ['connector-a', 'connector-b'])]
    );

    expect(rows.map((row) => [row.id, row.isGrouped])).toEqual([
      ['os-macbook', true],
      ['lonely-connector', false]
    ]);
    expect(rows[0].connectorCount).toBe(2);
    expect(rows[0].onlineConnectorCount).toBe(1);
  });

  test('treats a machine as online while any of its connectors is online', () => {
    const rows = rowsFor(
      [
        machine({ id: 'connector-a', status: 'offline' }),
        machine({ id: 'connector-b', status: 'local' })
      ],
      [physicalMachine('os-pc', ['connector-a', 'connector-b'])]
    );

    expect(rows[0].isOnline).toBe(true);
  });

  test('sorts online machines first and then by name', () => {
    const rows = rowsFor([
      machine({ id: 'zeta', status: 'online' }),
      machine({ id: 'alpha', status: 'offline' }),
      machine({ id: 'beta', status: 'online' })
    ]);

    expect(rows.map((row) => row.name)).toEqual(['beta', 'zeta', 'alpha']);
  });

  test('keeps a machine whose only connectors are archived out of the list', () => {
    const rows = rowsFor([], [physicalMachine('os-retired', ['gone'])]);

    expect(rows).toEqual([]);
  });
});

describe('filterMachineRows', () => {
  const rows = rowsFor([
    machine({ id: 'connector-mac', name: 'os-macbook', platform: 'darwin' }),
    machine({ id: 'connector-pc', name: 'os-yoga-unix', platform: 'linux', status: 'offline' })
  ]);

  test('returns every row without a query or filter', () => {
    expect(filterMachineRows({ filter: 'all', query: '', rows })).toHaveLength(2);
  });

  test('splits rows by connection state', () => {
    expect(
      filterMachineRows({ filter: 'online', query: '', rows }).map((row) => row.name)
    ).toEqual(['os-macbook']);
    expect(
      filterMachineRows({ filter: 'offline', query: '', rows }).map((row) => row.name)
    ).toEqual(['os-yoga-unix']);
  });

  test('searches machine names and connector identifiers', () => {
    expect(filterMachineRows({ filter: 'all', query: 'yoga', rows }).map((row) => row.name)).toEqual([
      'os-yoga-unix'
    ]);
    expect(
      filterMachineRows({ filter: 'all', query: 'connector-mac', rows }).map((row) => row.name)
    ).toEqual(['os-macbook']);
  });

  test('combines the filter with the query', () => {
    expect(filterMachineRows({ filter: 'online', query: 'yoga', rows })).toEqual([]);
  });
});

describe('computePlatformSections', () => {
  test('places a hosted environment under its host and a hostless one after', () => {
    const inventory = groupComputeInventory({
      connectors: [
        connectorAssociation('connector-a', 'env-hosted'),
        connectorAssociation('connector-b', 'env-hostless')
      ],
      environments: [
        environment({ hostId: 'host-1', id: 'env-hosted', platformId: 'local', resources }),
        environment({ id: 'env-hostless', platformId: 'local' })
      ],
      hosts: [host('host-1', 'local', resources)],
      platforms: [platform('local')]
    });
    const [section] = computePlatformSections(
      inventory,
      instancesById([machine({ id: 'connector-a' }), machine({ id: 'connector-b' })])
    );

    expect(section!.rows.map((row) => [row.kind, row.id, row.depth])).toEqual([
      ['host', 'host-1', 0],
      ['environment', 'env-hosted', 1],
      ['environment', 'env-hostless', 0]
    ]);
    expect(section!.rows[0]!.resourcesSummary).toBe('8 CPU · 16 GB · 512 GB');
    expect(section!.rows[1]!.instances.map((instance) => instance.id)).toEqual(['connector-a']);
  });

  test('nests a child environment one level deeper than its parent', () => {
    const inventory = groupComputeInventory({
      connectors: [connectorAssociation('connector-a', 'env-child')],
      environments: [
        environment({ id: 'env-parent', platformId: 'local' }),
        environment({ id: 'env-child', parentEnvironmentId: 'env-parent', platformId: 'local' })
      ],
      hosts: [],
      platforms: [platform('local')]
    });
    const [section] = computePlatformSections(inventory, instancesById([machine({ id: 'connector-a' })]));

    expect(section!.rows.map((row) => [row.id, row.depth])).toEqual([
      ['env-parent', 0],
      ['env-child', 1]
    ]);
  });

  test('rolls up a host row to the total connectors across its environments', () => {
    const inventory = groupComputeInventory({
      connectors: [
        connectorAssociation('connector-a', 'env-a'),
        connectorAssociation('connector-b', 'env-b')
      ],
      environments: [
        environment({ hostId: 'host-1', id: 'env-a', platformId: 'local' }),
        environment({ hostId: 'host-1', id: 'env-b', platformId: 'local' })
      ],
      hosts: [host('host-1', 'local')],
      platforms: [platform('local')]
    });
    const [section] = computePlatformSections(
      inventory,
      instancesById([
        machine({ id: 'connector-a', status: 'online' }),
        machine({ id: 'connector-b', status: 'offline' })
      ])
    );
    const [hostRow] = section!.rows;

    expect(hostRow!.connectorCount).toBe(2);
    expect(hostRow!.onlineConnectorCount).toBe(1);
    expect(hostRow!.isOnline).toBe(true);
  });

  test('sums section totals from environment rows only, not the host roll-up', () => {
    const inventory = groupComputeInventory({
      connectors: [connectorAssociation('connector-a', 'env-a')],
      environments: [environment({ hostId: 'host-1', id: 'env-a', platformId: 'local' })],
      hosts: [host('host-1', 'local')],
      platforms: [platform('local')]
    });
    const [section] = computePlatformSections(inventory, instancesById([machine({ id: 'connector-a' })]));

    expect(section!.connectorCount).toBe(1);
  });
});

describe('filterComputePlatformSections', () => {
  function twoHostInventory() {
    return groupComputeInventory({
      connectors: [
        connectorAssociation('connector-mac', 'env-macbook'),
        connectorAssociation('connector-pc', 'env-yoga')
      ],
      environments: [
        environment({ hostId: 'host-macbook', id: 'env-macbook', platformId: 'local' }),
        environment({ hostId: 'host-yoga', id: 'env-yoga', platformId: 'local' })
      ],
      hosts: [host('host-macbook', 'local'), host('host-yoga', 'local')],
      platforms: [platform('local')]
    });
  }

  function sections() {
    return computePlatformSections(
      twoHostInventory(),
      instancesById([
        machine({ id: 'connector-mac', name: 'os-macbook' }),
        machine({ id: 'connector-pc', name: 'os-yoga-unix', status: 'offline' })
      ])
    );
  }

  test('returns every section without a query or filter', () => {
    expect(filterComputePlatformSections(sections(), '', 'all')).toHaveLength(1);
  });

  test('keeps a host row once a descendant environment matches, even if the host name does not', () => {
    const filtered = filterComputePlatformSections(sections(), 'os-macbook', 'all');

    expect(filtered[0]!.rows.map((row) => row.id)).toEqual(['host-macbook', 'env-macbook']);
  });

  test('filters by connection state across the tree', () => {
    const online = filterComputePlatformSections(sections(), '', 'online');
    const offline = filterComputePlatformSections(sections(), '', 'offline');

    expect(online[0]!.rows.map((row) => row.id)).toEqual(['host-macbook', 'env-macbook']);
    expect(offline[0]!.rows.map((row) => row.id)).toEqual(['host-yoga', 'env-yoga']);
  });

  test('drops the platform entirely once nothing survives', () => {
    expect(filterComputePlatformSections(sections(), 'does-not-exist', 'all')).toEqual([]);
  });
});

describe('machineRowSubtitle', () => {
  test('names the single connector without an online ratio', () => {
    const [row] = rowsFor([machine({ id: 'connector-mac', name: 'os-macbook', platform: 'darwin' })]);

    expect(machineRowSubtitle(row)).toBe('macOS · 1 connector');
  });

  test('reports how many connectors of a machine are online', () => {
    const [row] = rowsFor(
      [
        machine({ id: 'connector-a', platform: 'darwin' }),
        machine({ id: 'connector-b', platform: 'linux', status: 'offline' })
      ],
      [physicalMachine('os-macbook', ['connector-a', 'connector-b'])]
    );

    expect(machineRowSubtitle(row)).toContain('1 of 2 connectors online');
  });
});
