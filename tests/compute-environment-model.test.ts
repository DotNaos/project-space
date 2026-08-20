import { describe, expect, test } from 'bun:test';

import {
  groupComputeInventory,
  builtInEnvironmentDefinition,
  hostAssociationLabel,
  reconcileBuiltInEnvironmentDefinitions,
  resolveDerivedIdentity,
  resourceCapacityOwner,
  validateComputeInventory,
  type ComputeEnvironmentRecord,
  type ComputeEnvironmentKind,
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
  const kind = overrides.kind ?? 'native_linux';
  return {
    environmentDefinitionId: `definition-${kind}`,
    hostAssociation: { evidence: 'smbios', hostId: 'pc', resolution: 'verified' },
    id,
    identity: { key: `account-derived-${id}`, version: 1 },
    kind,
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
  const environments = overrides.environments ?? [];
  const kinds = [...new Set(environments.map(({ kind }) => kind))];
  return {
    connectors: [],
    environmentDefinitions: kinds.map((kind) => definition(kind)),
    environments,
    hosts: [pc],
    platforms: [local],
    ...overrides
  };
}

function definition(kind: ComputeEnvironmentKind) {
  return {
    ...builtInEnvironmentDefinition(kind),
    id: `definition-${kind}`
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
  test('reconciles equivalent built-in definitions deterministically across scopes', () => {
    const canonical = {
      ...definition('native_macos'),
      id: '204ef6c6-688f-4df5-ae08-e2df1d6cb762'
    };
    const duplicate = { ...canonical, id: '2462cc6a-24e6-49e0-80c7-02d69b038a9b' };
    const result = reconcileBuiltInEnvironmentDefinitions({
      environmentDefinitions: [duplicate, canonical],
      environments: [environment('mac', {
        environmentDefinitionId: duplicate.id,
        kind: 'native_macos'
      })]
    });

    expect(result.environmentDefinitions.map(({ id }) => id)).toEqual([canonical.id]);
    expect(result.environments[0]?.environmentDefinitionId).toBe(canonical.id);
    expect(validateComputeInventory({
      ...inventory({ environments: result.environments }),
      environmentDefinitions: result.environmentDefinitions
    })).toEqual([]);
  });

  test('keeps user-owned and conflicting built-in definitions fail-closed', () => {
    const builtIn = { ...definition('native_macos'), id: 'built-in-macos' };
    const userOwned = {
      ...builtIn,
      id: 'user-macos',
      name: 'My macOS',
      ownership: 'user_defined' as const
    };
    const conflictingBuiltIn = { ...builtIn, id: 'other-built-in-macos', name: 'Different macOS' };
    const environments = [
      environment('built-in-environment', {
        environmentDefinitionId: builtIn.id,
        kind: 'native_macos'
      }),
      environment('user-environment', {
        environmentDefinitionId: userOwned.id,
        kind: 'native_macos'
      })
    ];
    const result = reconcileBuiltInEnvironmentDefinitions({
      environmentDefinitions: [builtIn, userOwned, conflictingBuiltIn],
      environments
    });

    expect(result.environmentDefinitions).toHaveLength(3);
    expect(validateComputeInventory({
      ...inventory({ environments: result.environments }),
      environmentDefinitions: result.environmentDefinitions
    }).map(({ code }) => code)).toContain('duplicate_environment_definition_slug');
  });

  test('separates reusable definitions from concrete execution targets', () => {
    const first = environment('windows-01', { kind: 'native_windows' });
    const second = environment('windows-02', {
      hostAssociation: { evidence: 'none', resolution: 'unresolved' },
      kind: 'native_windows'
    });
    const input = inventory({ environments: [first, second] });

    expect(input.environmentDefinitions).toHaveLength(1);
    expect(first.environmentDefinitionId).toBe(second.environmentDefinitionId);
    expect(first.id).not.toBe(second.id);
    expect(validateComputeInventory(input)).toEqual([]);
  });

  test('fails closed when a concrete instance has no matching definition', () => {
    const windows = environment('windows', { kind: 'native_windows' });
    expect(validateComputeInventory(inventory({
      environmentDefinitions: [],
      environments: [windows]
    }))).toEqual([{
      code: 'environment_definition_missing',
      id: 'windows'
    }]);

    expect(validateComputeInventory(inventory({
      environmentDefinitions: [definition('native_linux')],
      environments: [{
        ...windows,
        environmentDefinitionId: 'definition-native_linux'
      }]
    }))).toEqual([{
      code: 'environment_definition_kind_mismatch',
      id: 'windows'
    }]);
  });

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

  test('keeps scoped identity tuples collision-free', () => {
    const firstPlatform: ComputePlatformRecord = { id: 'a', kind: 'other', name: 'First' };
    const secondPlatform: ComputePlatformRecord = { id: 'a:1:b', kind: 'other', name: 'Second' };
    const firstHost: ComputeHostRecord = {
      id: 'first-host',
      identity: { key: 'b:2:c', version: 1 },
      name: 'First host',
      platformId: firstPlatform.id
    };
    const secondHost: ComputeHostRecord = {
      id: 'second-host',
      identity: { key: 'c', version: 2 },
      name: 'Second host',
      platformId: secondPlatform.id
    };
    const firstEnvironment = environment('first-environment', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      identity: firstHost.identity,
      platformId: firstPlatform.id
    });
    const secondEnvironment = environment('second-environment', {
      hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
      identity: secondHost.identity,
      platformId: secondPlatform.id
    });

    expect(validateComputeInventory(inventory({
      environments: [firstEnvironment, secondEnvironment],
      hosts: [firstHost, secondHost],
      platforms: [firstPlatform, secondPlatform]
    }))).toEqual([]);
  });

  test('validates every host reference carried by a conflicted association', () => {
    const conflicted = environment('conflicted', {
      hostAssociation: {
        evidence: 'host_broker',
        expectedHostId: 'missing-host',
        resolution: 'conflict'
      }
    });

    expect(validateComputeInventory(inventory({ environments: [conflicted] }))).toEqual([
      { code: 'environment_host_missing', id: 'conflicted' }
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

  test('keeps unresolved exclusive environment capacity distinct', () => {
    const first = environment('unresolved-first', {
      hostAssociation: { evidence: 'none', resolution: 'unresolved' }
    });
    const second = environment('unresolved-second', {
      hostAssociation: {
        evidence: 'host_broker',
        expectedHostId: 'pc',
        resolution: 'conflict'
      }
    });

    expect(resourceCapacityOwner(first, [first, second]))
      .toBe('environment:unresolved-first');
    expect(resourceCapacityOwner(second, [first, second]))
      .toBe('environment:unresolved-second');
  });
});
