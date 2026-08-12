import { describe, expect, test } from 'bun:test';

import { computeInventoryFromConnectors } from '../server/compute-inventory';
import { groupComputeInventory, resourceCapacityOwner } from '../src/shared/compute-environment-api';
import type { MachineRecord } from '../src/shared/project-space-api';

function connector(id: string, overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    connector: { installCommand: 'project connector install', status: 'online' },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: ['connector'],
    sourcePath: 'test',
    ...overrides
  };
}

describe('runtime compute inventory', () => {
  test('never leaves a legacy connector without an explicit environment', () => {
    const snapshot = computeInventoryFromConnectors({ connectors: [connector('legacy-one')] });
    expect(snapshot.violations).toEqual([]);
    expect(snapshot.connectors).toHaveLength(1);
    expect(snapshot.environmentDefinitions).toEqual([{
      bootstrapStrategy: 'custom',
      id: expect.stringMatching(/^environment-definition-/),
      kind: 'other',
      name: 'Other',
      operatingSystemFamily: 'other',
      ownership: 'built_in',
      slug: 'other',
      supportedArchitectures: []
    }]);
    expect(snapshot.environments[0]?.environmentDefinitionId)
      .toBe(snapshot.environmentDefinitions[0]?.id);
    expect(snapshot.environments).toHaveLength(1);
    expect(snapshot.environmentDefinitions).toHaveLength(1);
    expect(snapshot.environments[0]?.hostAssociation).toEqual({
      evidence: 'none',
      resolution: 'unresolved'
    });
  });

  test('groups two connector channels by reported environment identity', () => {
    const compute = {
      environmentIdentity: { key: 'environment:0123456789abcdef', version: 1 },
      environmentKind: 'wsl' as const,
      environmentName: 'Ubuntu',
      hostEvidence: 'none' as const,
      hostResolution: 'unresolved' as const,
      platformKind: 'local' as const,
      platformName: 'Local & self-hosted',
      resourceMode: 'dedicated' as const
    };
    const snapshot = computeInventoryFromConnectors({
      connectors: [connector('stable', { compute }), connector('dev', { compute })]
    });
    expect(snapshot.environments).toHaveLength(1);
    expect(snapshot.connectors.map(({ environmentId }) => environmentId)).toEqual([
      snapshot.environments[0]!.id,
      snapshot.environments[0]!.id
    ]);
  });

  test('keeps Codespaces on the provider platform without inventing a host', () => {
    const snapshot = computeInventoryFromConnectors({
      connectors: [connector('codespace', {
        compute: {
          environmentIdentity: { key: 'environment:codespace01234567', version: 1 },
          environmentKind: 'github_codespace',
          environmentName: 'bug-free-space-invention',
          hostEvidence: 'provider',
          hostResolution: 'not_applicable',
          platformKind: 'github_codespaces',
          platformName: 'GitHub Codespaces',
          resourceMode: 'dedicated'
        }
      })]
    });
    const hierarchy = groupComputeInventory(snapshot);
    expect(hierarchy.platforms[0]?.platform.name).toBe('GitHub Codespaces');
    expect(hierarchy.platforms[0]?.hosts).toEqual([]);
    expect(hierarchy.platforms[0]?.environments[0]?.environment.kind)
      .toBe('github_codespace');
  });

  test('counts host-backed resources through one capacity owner', () => {
    const resources = {
      architecture: 'amd64',
      cpu: { cores: 8 },
      memory: { totalBytes: 16_000 },
      operatingSystem: 'linux',
      reportedAt: '2026-08-08T00:00:00.000Z',
      source: 'connector' as const,
      storage: { totalBytes: 100_000 }
    };
    const snapshot = computeInventoryFromConnectors({
      connectors: [connector('native', {
        compute: {
          environmentIdentity: { key: 'environment:native012345678', version: 1 },
          environmentKind: 'native_linux',
          environmentName: 'Ubuntu',
          hostEvidence: 'smbios',
          hostIdentity: { key: 'host:physical01234567890', version: 1 },
          hostName: 'Laptop',
          hostResolution: 'verified',
          platformKind: 'local',
          platformName: 'Local & self-hosted',
          resourceMode: 'exclusive',
          resources
        }
      })]
    });
    const environment = snapshot.environments[0]!;
    expect(environment.resources).toBeUndefined();
    expect(snapshot.hosts[0]?.resources).toEqual(resources);
    expect(resourceCapacityOwner(environment, snapshot.environments))
      .toBe(`host:${snapshot.hosts[0]!.id}`);
  });

  test('keeps a dedicated environment allocation separate from host capacity', () => {
    const resources = {
      architecture: 'amd64',
      cpu: { cores: 4 },
      memory: { totalBytes: 8_000 },
      operatingSystem: 'linux',
      reportedAt: '2026-08-08T00:00:00.000Z',
      source: 'connector' as const,
      storage: { totalBytes: 50_000 }
    };
    const snapshot = computeInventoryFromConnectors({
      connectors: [connector('wsl', {
        compute: {
          environmentIdentity: { key: 'environment:wsl012345678901', version: 1 },
          environmentKind: 'wsl',
          environmentName: 'Ubuntu',
          hostEvidence: 'smbios',
          hostIdentity: { key: 'host:physical01234567890', version: 1 },
          hostName: 'Windows PC',
          hostResolution: 'verified',
          platformKind: 'local',
          platformName: 'Local & self-hosted',
          resourceMode: 'dedicated',
          resources
        }
      })]
    });
    const environment = snapshot.environments[0]!;
    expect(snapshot.hosts[0]?.resources).toBeUndefined();
    expect(environment.resources).toEqual(resources);
    expect(resourceCapacityOwner(environment, snapshot.environments))
      .toBe(`environment:${environment.id}`);
  });

  test('nests a managed container under its trusted parent claim', () => {
    const snapshot = computeInventoryFromConnectors({
      connectors: [connector('container', {
        compute: {
          environmentIdentity: { key: 'environment:container012345', version: 1 },
          environmentKind: 'docker',
          environmentName: 'Docker devbox',
          hostEvidence: 'none',
          hostResolution: 'unresolved',
          parentEnvironmentIdentity: { key: 'environment:parent01234567', version: 1 },
          platformKind: 'local',
          platformName: 'Local & self-hosted',
          resourceMode: 'shared'
        }
      })]
    });
    const hierarchy = groupComputeInventory(snapshot);
    const parent = hierarchy.platforms[0]?.environments[0];
    expect(parent?.children[0]?.environment.kind).toBe('docker');
    expect(parent?.children[0]?.connectors[0]?.connectorId).toBe('container');
  });
});
