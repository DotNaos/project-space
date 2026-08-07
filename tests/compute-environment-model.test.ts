import { describe, expect, test } from 'bun:test';

import {
  groupComputeInventory,
  hostAssociationLabel,
  resolveDerivedIdentity,
  resourceCapacityOwner,
  validateComputeInventory,
  type ComputeEnvironmentRecord,
  type ComputeHostRecord,
  type ComputeInventoryInput,
  type ComputePlatformRecord,
  type ConnectorEnvironmentAssociation
} from '../src/shared/compute-environment-api';

const local: ComputePlatformRecord = { id: 'local', kind: 'local', name: 'Local devices' };
const codespaces: ComputePlatformRecord = {
  id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces'
};
const pc: ComputeHostRecord = {
  id: 'pc', identity: { key: 'account-derived-pc', version: 1 }, name: 'Desktop PC', platformId: 'local'
};

function environment(
  id: string,
  overrides: Partial<ComputeEnvironmentRecord> = {}
): ComputeEnvironmentRecord {
  return {
    hostAssociation: { evidence: 'smbios', hostId: 'pc', resolution: 'verified' },
    id,
    identity: { key: `account-derived-${id}`, version: 1 },
    kind: 'native_linux',
    name: id,
    platformId: 'local',
    resourceMode: 'exclusive',
    ...overrides
  };
}

function connector(connectorId: string, environmentId: string): ConnectorEnvironmentAssociation {
  return { associatedAt: '2026-08-07T00:00:00.000Z', connectorId, environmentId };
}

function inventory(overrides: Partial<ComputeInventoryInput> = {}): ComputeInventoryInput {
  return {
    connectors: [],
    environments: [],
    hosts: [pc],
    platforms: [local],
    ...overrides
  };
}

describe('compute identity resolution', () => {
  test('is deterministic and ignores display metadata by accepting derived claims only', () => {
    const identity = { key: 'account-scoped-value', version: 2 };
    expect(resolveDerivedIdentity([
      { evidence: 'tpm', identity },
      { evidence: 'host_broker', identity }
    ])).toEqual({ identity, state: 'resolved' });
    expect(resolveDerivedIdentity([])).toEqual({ state: 'unresolved' });
  });

  test('fails conflicting trustworthy claims closed', () => {
    expect(resolveDerivedIdentity([
      { evidence: 'provider', identity: { key: 'one', version: 1 } },
      { evidence: 'provider', identity: { key: 'two', version: 1 } }
    ])).toMatchObject({ state: 'conflict' });
  });

  test('renders uncertainty and provider-managed truth honestly', () => {
    expect(hostAssociationLabel({ evidence: 'smbios', hostId: 'pc', resolution: 'verified' }))
      .toBe('Verified · smbios');
    expect(hostAssociationLabel({ evidence: 'user', hostId: 'pc', resolution: 'manual' }))
      .toBe('Manually assigned');
    expect(hostAssociationLabel({ evidence: 'none', resolution: 'unresolved' }))
      .toBe('Needs assignment');
    expect(hostAssociationLabel({ evidence: 'host_broker', resolution: 'conflict' }))
      .toBe('Conflict · review required');
    expect(hostAssociationLabel({ evidence: 'provider', resolution: 'not_applicable' }))
      .toBe('Provider managed');
  });
});

describe('compute hierarchy and connector invariants', () => {
  test('models dual boot as one host with separate exclusive native environments', () => {
    const windows = environment('windows', { kind: 'native_windows', name: 'Windows' });
    const ubuntu = environment('ubuntu', { kind: 'native_linux', name: 'Ubuntu' });
    const grouped = groupComputeInventory(inventory({ environments: [windows, ubuntu] }));

    expect(grouped.platforms[0]?.hosts[0]?.environments.map(({ environment }) => environment.id))
      .toEqual(['ubuntu', 'windows']);
    expect(resourceCapacityOwner(windows, [windows, ubuntu])).toBe('host:pc');
    expect(resourceCapacityOwner(ubuntu, [windows, ubuntu])).toBe('host:pc');
  });

  test('nests WSL and Docker through trusted parent evidence', () => {
    const windows = environment('windows', { kind: 'native_windows' });
    const wsl = environment('wsl', {
      hostAssociation: { evidence: 'host_broker', hostId: 'pc', resolution: 'verified' },
      kind: 'wsl', parentEnvironmentId: 'windows', resourceMode: 'shared'
    });
    const docker = environment('docker', {
      hostAssociation: { evidence: 'host_broker', hostId: 'pc', resolution: 'verified' },
      kind: 'docker', parentEnvironmentId: 'wsl', resourceMode: 'shared'
    });
    const grouped = groupComputeInventory(inventory({ environments: [docker, windows, wsl] }));

    expect(grouped.platforms[0]?.hosts[0]?.environments[0]?.children[0]?.children[0]?.environment.id)
      .toBe('docker');
  });

  test('keeps multiple connector channels in one environment without duplicating resources', () => {
    const mac = environment('mac', { kind: 'native_macos', resourceMode: 'exclusive' });
    const grouped = groupComputeInventory(inventory({
      connectors: [connector('stable', 'mac'), connector('dev', 'mac')],
      environments: [mac]
    }));

    expect(grouped.platforms[0]?.hosts[0]?.environments[0]?.connectors.map(({ connectorId }) => connectorId))
      .toEqual(['dev', 'stable']);
    expect(resourceCapacityOwner(mac, [mac])).toBe('host:pc');
  });

  test('groups provider-managed Codespaces without fabricating hosts', () => {
    const first = environment('codespace-1', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      kind: 'github_codespace', platformId: 'codespaces', resourceMode: 'dedicated'
    });
    const second = environment('codespace-2', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      kind: 'github_codespace', platformId: 'codespaces', resourceMode: 'dedicated'
    });
    const grouped = groupComputeInventory(inventory({
      environments: [first, second], hosts: [], platforms: [codespaces]
    }));

    expect(grouped.platforms[0]?.hosts).toEqual([]);
    expect(grouped.platforms[0]?.environments.map(({ environment }) => environment.id))
      .toEqual(['codespace-1', 'codespace-2']);
    expect(resourceCapacityOwner(first, [first, second])).toBe('environment:codespace-1');
  });

  test('allows hosts, environments, and provider sandboxes to exist before a connector enrolls', () => {
    const sandbox = environment('sandbox', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      kind: 'cloud_sandbox', platformId: 'cloud', resourceMode: 'dedicated'
    });
    expect(validateComputeInventory(inventory({
      environments: [sandbox],
      hosts: [pc],
      platforms: [local, { id: 'cloud', kind: 'cloud_sandbox', name: 'Cloud sandboxes' }]
    }))).toEqual([]);
  });

  test('rejects unassigned, duplicate, and cross-hierarchy connector state', () => {
    const windows = environment('windows', { kind: 'native_windows' });
    const invalid = validateComputeInventory(inventory({
      connectors: [connector('same', 'windows'), connector('same', 'missing')],
      environments: [windows, { ...windows, id: 'duplicate-key' }]
    }));

    expect(invalid.map(({ code }) => code)).toEqual([
      'connector_environment_missing',
      'duplicate_connector',
      'duplicate_environment_identity'
    ]);
  });

  test('rejects cyclic nesting instead of dropping it from the inventory tree', () => {
    const first = environment('first', { parentEnvironmentId: 'second' });
    const second = environment('second', { parentEnvironmentId: 'first' });

    expect(validateComputeInventory(inventory({ environments: [first, second] })))
      .toEqual([
        { code: 'environment_parent_cycle', id: 'first' },
        { code: 'environment_parent_cycle', id: 'second' }
      ]);
    expect(() => resourceCapacityOwner(
      { ...first, hostAssociation: { evidence: 'none', resolution: 'unresolved' }, resourceMode: 'shared' },
      [
        { ...first, hostAssociation: { evidence: 'none', resolution: 'unresolved' }, resourceMode: 'shared' },
        { ...second, hostAssociation: { evidence: 'none', resolution: 'unresolved' }, resourceMode: 'shared' }
      ]
    )).toThrow('Environment parent cycle');
  });

  test('does not add shared nested or exclusive host capacity twice', () => {
    const native = environment('native');
    const nested = environment('container', {
      hostAssociation: { evidence: 'host_broker', hostId: 'pc', resolution: 'verified' },
      kind: 'docker', parentEnvironmentId: 'native', resourceMode: 'shared'
    });
    const providerParent = environment('cluster', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      platformId: 'kubernetes', resourceMode: 'shared'
    });
    const workload = environment('pod', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      kind: 'kubernetes_workload', parentEnvironmentId: 'cluster',
      platformId: 'kubernetes', resourceMode: 'shared'
    });

    expect(new Set([native, nested].map((entry) => resourceCapacityOwner(entry, [native, nested]))).size)
      .toBe(1);
    expect(resourceCapacityOwner(workload, [providerParent, workload]))
      .toBe('platform:kubernetes:shared');
  });
});
