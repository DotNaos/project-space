import { describe, expect, test } from 'bun:test';
import type {
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliHost,
  ProjectCliPlatform
} from '../src/shared/compute-inventory-cli-api';
import {
  computeInventoryCounts,
  computePlatformSections,
  filterComputePlatformSections,
  isComputeInventoryStale
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
  workspaces = []
}: Partial<ProjectCliEnvironmentInstance> & {
  alias: string;
  routeState?: 'ready' | 'unavailable';
}): ProjectCliEnvironmentInstance {
  return {
    accessRoutes: routeState ? [{ capabilities: [], id: `route-${id}`, lastVerifiedAt: new Date().toISOString(), priority: 1, state: routeState, type: 'ssh_private_network' }] : [],
    alias,
    environmentDefinitionId: `definition-${kind}`,
    hostId,
    hostResolution: hostId ? 'manual' : 'not_applicable',
    hostd: { state: 'unknown' },
    id,
    kind,
    name: alias,
    parentEnvironmentInstanceId,
    platformId,
    providerLifecycleState: 'unknown',
    reference: `reference-${id}`,
    resourceMode,
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
    expect(section!.rows[1]!.environmentStatus).toBe('Status unavailable');
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
  });

  test('counts mixed inventories and distinguishes stale data', () => {
    const sections = computePlatformSections(inventory({
      environmentInstances: [environment({ alias: 'one', hostId: 'host-a', workspaces: [{ id: 'w', name: 'Workspace', state: 'active' }] })],
      hosts: [host('host-a', 'local')]
    }));
    expect(computeInventoryCounts(sections)).toEqual({ environments: 1, hosts: 1, workspaces: 1 });
    expect(isComputeInventoryStale('2026-08-13T11:00:00.000Z', Date.parse('2026-08-13T11:20:00.000Z'))).toBe(true);
    expect(isComputeInventoryStale('2026-08-13T11:19:00.000Z', Date.parse('2026-08-13T11:20:00.000Z'))).toBe(false);
  });
});
