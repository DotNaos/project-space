import { describe, expect, test } from 'bun:test';

import {
  getIssueMachineRows,
  physicalMachineSummary
} from '../src/features/project-desktop/components/issue-development-machine-actions';
import type {
  ConnectorOverviewResult,
  ConnectorStatus,
  MachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';
import type { ComputeEnvironmentRecord } from '../src/shared/compute-environment-api';

function machine(
  id: string,
  status: ConnectorStatus,
  name = id
): MachineRecord {
  return {
    connector: { installCommand: '', status },
    id,
    kind: 'connector',
    name,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function project(overrides: Partial<ProjectSpaceRecord> = {}): ProjectSpaceRecord {
  return {
    gitStatus: {
      branchName: 'main',
      changed: 0,
      hasUnstagedChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0
    },
    id: 'connector-project:b3MtcGM:cHJvamVjdC1zcGFjZQ',
    kind: 'standalone',
    machineId: 'connector-pc',
    name: 'project-space',
    rootPath: '/home/oli/projects/project-space',
    ...overrides
  };
}

function overview({
  computeEnvironments = [],
  machines,
  physicalMachines,
  environments = []
}: {
  computeEnvironments?: ComputeEnvironmentRecord[];
  environments?: Array<{ connectorId: string; environmentId: string }>;
  machines: MachineRecord[];
  physicalMachines: ConnectorOverviewResult['physicalMachines'];
}): ConnectorOverviewResult {
  return {
    computeInventory: {
      connectors: environments.map((environment, index) => ({
        associatedAt: `2026-08-10T00:00:0${index}.000Z`,
        ...environment
      })),
      environments: computeEnvironments,
      hosts: [],
      platforms: [],
      violations: []
    },
    machines,
    machinesRepo: { exists: false, path: '' },
    physicalMachines,
    tailscale: {
      connected: false,
      installed: false,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    }
  };
}

function computeEnvironment(
  id: string,
  kind: ComputeEnvironmentRecord['kind'],
  name: string
): ComputeEnvironmentRecord {
  return {
    hostAssociation: { evidence: 'none', resolution: 'unresolved' },
    id,
    identity: { key: id, version: 1 },
    kind,
    name,
    platformId: 'platform-local',
    resourceMode: 'dedicated'
  };
}

describe('issue development machine actions', () => {
  test('keeps two configured physical machines and summarizes their online state', () => {
    const connectorOverview = overview({
      machines: [
        machine('connector-mac', 'online'),
        machine('connector-pc', 'offline')
      ],
      physicalMachines: [
        { connectorIds: ['connector-mac'], id: 'physical-mac', name: 'os-macbook' },
        { connectorIds: ['connector-pc'], id: 'physical-pc', name: 'os-pc' }
      ]
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows.map(({ physicalMachineId, physicalMachineName }) => ({
      physicalMachineId,
      physicalMachineName
    }))).toEqual([
      { physicalMachineId: 'physical-mac', physicalMachineName: 'os-macbook' },
      { physicalMachineId: 'physical-pc', physicalMachineName: 'os-pc' }
    ]);
    expect(physicalMachineSummary(rows)).toEqual({ configured: 2, online: 1 });
  });

  test('orders online physical machines before alphabetically earlier offline machines', () => {
    const connectorOverview = overview({
      machines: [
        machine('connector-offline', 'offline'),
        machine('connector-online', 'online')
      ],
      physicalMachines: [
        { connectorIds: ['connector-offline'], id: 'physical-offline', name: 'a-build' },
        { connectorIds: ['connector-online'], id: 'physical-online', name: 'z-workstation' }
      ]
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows.map((row) => row.physicalMachineName)).toEqual([
      'z-workstation',
      'a-build'
    ]);
  });

  test('exposes every connector option with environment and capability metadata', () => {
    const connectorOverview = overview({
      computeEnvironments: [
        computeEnvironment('environment-windows', 'native_windows', 'Windows 11'),
        computeEnvironment('environment-wsl', 'wsl', 'Ubuntu 24.04')
      ],
      environments: [
        { connectorId: 'connector-windows', environmentId: 'environment-windows' },
        { connectorId: 'connector-wsl', environmentId: 'environment-wsl' }
      ],
      machines: [
        machine('connector-windows', 'offline', 'Windows connector'),
        machine('connector-wsl', 'online', 'Ubuntu connector')
      ],
      physicalMachines: [{
        connectorIds: ['connector-wsl', 'connector-windows'],
        id: 'physical-pc',
        name: 'os-pc'
      }]
    });

    const [row] = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(row?.connectorIds).toEqual(['connector-wsl', 'connector-windows']);
    expect(row?.connectorOptions?.map((option) => ({
      canRunCommand: option.canRunCommand,
      connectorId: option.connectorId,
      connectorName: option.connectorName,
      environmentId: option.environmentId,
      environmentKind: option.environmentKind,
      environmentLabel: option.environmentLabel,
      environmentName: option.environmentName,
      hasProjectCheckout: option.hasProjectCheckout,
      isOnline: option.isOnline
    }))).toEqual([
      {
        canRunCommand: false,
        connectorId: 'connector-windows',
        connectorName: 'Windows connector',
        environmentId: 'environment-windows',
        environmentKind: 'native_windows',
        environmentLabel: 'Windows 11',
        environmentName: 'Windows 11',
        hasProjectCheckout: false,
        isOnline: false
      },
      {
        canRunCommand: true,
        connectorId: 'connector-wsl',
        connectorName: 'Ubuntu connector',
        environmentId: 'environment-wsl',
        environmentKind: 'wsl',
        environmentLabel: 'WSL · Ubuntu 24.04',
        environmentName: 'Ubuntu 24.04',
        hasProjectCheckout: false,
        isOnline: true
      }
    ]);
  });

  test('suggests a runnable connector before an offline checkout without hiding alternatives', () => {
    const onlineConnector = machine('connector-online', 'online');
    const checkoutConnector = machine('connector-checkout', 'offline');
    const checkout = project({ machineId: checkoutConnector.id });
    const connectorOverview = overview({
      machines: [onlineConnector, checkoutConnector],
      physicalMachines: [{
        connectorIds: [onlineConnector.id, checkoutConnector.id],
        id: 'physical-pc',
        name: 'os-pc'
      }]
    });

    const [row] = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [checkout],
      repoFullName: 'DotNaos/project-space'
    });

    expect(row).toMatchObject({
      machineId: onlineConnector.id,
      suggestedConnectorId: onlineConnector.id
    });
    expect(row?.connectorOptions?.map(({ connectorId, hasProjectCheckout }) => ({
      connectorId,
      hasProjectCheckout
    }))).toEqual([
      { connectorId: checkoutConnector.id, hasProjectCheckout: true },
      { connectorId: onlineConnector.id, hasProjectCheckout: false }
    ]);
  });

  test('prefers a runnable checkout over every other connector state', () => {
    const runnableCheckout = machine('connector-runnable-checkout', 'online');
    const runnable = machine('connector-runnable', 'online');
    const offlineCheckout = machine('connector-offline-checkout', 'offline');
    const connectorOverview = overview({
      machines: [runnable, offlineCheckout, runnableCheckout],
      physicalMachines: [{
        connectorIds: [runnable.id, offlineCheckout.id, runnableCheckout.id],
        id: 'physical-pc',
        name: 'os-pc'
      }]
    });

    const [row] = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [
        project({ machineId: offlineCheckout.id, rootPath: '/offline/project-space' }),
        project({ machineId: runnableCheckout.id, rootPath: '/online/project-space' })
      ],
      repoFullName: 'DotNaos/project-space'
    });

    expect(row).toMatchObject({
      machineId: runnableCheckout.id,
      suggestedConnectorId: runnableCheckout.id
    });
  });

  test('does not attach a same-named checkout from another repository owner', () => {
    const connector = machine('connector-pc', 'online');
    const wrongRepository = project({
      github: { fullName: 'Other/project-space' } as ProjectSpaceRecord['github'],
      machineId: connector.id
    });
    const connectorOverview = overview({
      machines: [connector],
      physicalMachines: [{
        connectorIds: [connector.id],
        id: 'physical-pc',
        name: 'os-pc'
      }]
    });

    const [row] = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [wrongRepository],
      repoFullName: 'DotNaos/project-space'
    });

    expect(row?.connectorOptions?.[0]).toMatchObject({
      hasProjectCheckout: false,
      project: undefined
    });
  });

  test('uses connector topology evidence without guessing from the physical machine name', () => {
    const macConnector = machine('connector-mac', 'online');
    macConnector.environment = { kind: 'macos' };
    const unknownConnector = machine('connector-unknown', 'online');
    const connectorOverview = overview({
      machines: [unknownConnector, macConnector],
      physicalMachines: [{
        connectorIds: [unknownConnector.id, macConnector.id],
        id: 'physical-ubuntu',
        name: 'Ubuntu build machine'
      }]
    });

    const [row] = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });
    const options = new Map(row?.connectorOptions?.map((option) => [option.connectorId, option]));

    expect(options.get(macConnector.id)).toMatchObject({
      environmentKind: 'macos',
      environmentLabel: 'macOS'
    });
    expect(options.get(unknownConnector.id)).not.toHaveProperty('environmentKind');
    expect(options.get(unknownConnector.id)).not.toHaveProperty('environmentLabel');
    expect(options.get(unknownConnector.id)).not.toHaveProperty('environmentName');
  });

  test('chooses the same suggested connector regardless of inventory order', () => {
    const connectorA = machine('connector-a', 'online');
    const connectorB = machine('connector-b', 'online');
    const input = (machines: MachineRecord[], connectorIds: string[]) => getIssueMachineRows({
      connectorOverview: overview({
        machines,
        physicalMachines: [{ connectorIds, id: 'physical-pc', name: 'os-pc' }]
      }),
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    })[0];

    const forward = input([connectorA, connectorB], [connectorA.id, connectorB.id]);
    const reverse = input([connectorB, connectorA], [connectorB.id, connectorA.id]);

    expect(forward?.suggestedConnectorId).toBe('connector-a');
    expect(reverse?.suggestedConnectorId).toBe('connector-a');
    expect(forward?.connectorOptions?.map(({ connectorId }) => connectorId)).toEqual([
      'connector-a',
      'connector-b'
    ]);
    expect(reverse?.connectorOptions?.map(({ connectorId }) => connectorId)).toEqual([
      'connector-a',
      'connector-b'
    ]);
  });

  test('orders physical machines deterministically by stable name and id', () => {
    const connectorA = machine('connector-a', 'online');
    const connectorB = machine('connector-b', 'online');
    const connectorC = machine('connector-c', 'offline');
    const connectorOverview = overview({
      machines: [connectorC, connectorA, connectorB],
      physicalMachines: [
        { connectorIds: [connectorC.id], id: 'physical-c', name: 'zeta' },
        { connectorIds: [connectorB.id], id: 'physical-b', name: 'alpha' },
        { connectorIds: [connectorA.id], id: 'physical-a', name: 'alpha' }
      ]
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows.map((row) => row.physicalMachineId)).toEqual([
      'physical-a',
      'physical-b',
      'physical-c'
    ]);
  });

  test('keeps a configured machine visible while connector inventory is unavailable', () => {
    const connectorOverview = overview({
      machines: [],
      physicalMachines: [{
        connectorIds: ['connector-unavailable'],
        id: 'physical-unavailable',
        name: 'build-linux'
      }]
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      machineId: 'connector-unavailable',
      physicalMachineId: 'physical-unavailable',
      suggestedConnectorId: 'connector-unavailable'
    });
    expect(rows[0]?.connectorOptions).toMatchObject([{
      canRunCommand: false,
      connectorId: 'connector-unavailable',
      connectorName: 'connector-unavailable',
      hasProjectCheckout: false,
      isOnline: false
    }]);
    expect(physicalMachineSummary(rows)).toEqual({ configured: 1, online: 0 });
  });

  test('falls back to every known non-Codespace connector when physical grouping is absent', () => {
    const local = machine('connector-local', 'local', 'os-macbook');
    const remote = machine('connector-remote', 'not-installed', 'os-yoga-unix');
    const codespace = machine('connector-codespace', 'online', 'Project Codespace');
    codespace.compute = { environmentKind: 'github_codespace', environmentName: 'Codespace' };
    const connectorOverview = overview({
      machines: [remote, codespace, local],
      physicalMachines: []
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows.map((row) => ({
      machineId: row.machineId,
      physicalMachineId: row.physicalMachineId,
      physicalMachineName: row.physicalMachineName
    }))).toEqual([
      {
        machineId: 'connector-local',
        physicalMachineId: undefined,
        physicalMachineName: 'os-macbook'
      },
      {
        machineId: 'connector-remote',
        physicalMachineId: undefined,
        physicalMachineName: 'os-yoga-unix'
      }
    ]);
    expect(physicalMachineSummary(rows)).toEqual({ configured: 2, online: 1 });
  });

  test('adds ungrouped connectors beside configured physical machines', () => {
    const grouped = machine('connector-grouped', 'online', 'Grouped connector');
    const standalone = machine('connector-standalone', 'offline', 'Standalone connector');
    const connectorOverview = overview({
      machines: [standalone, grouped],
      physicalMachines: [{
        connectorIds: [grouped.id],
        id: 'physical-grouped',
        name: 'os-pc'
      }]
    });

    const rows = getIssueMachineRows({
      connectorOverview,
      project: project(),
      projects: [],
      repoFullName: 'DotNaos/project-space'
    });

    expect(rows.map((row) => row.physicalMachineName)).toEqual([
      'os-pc',
      'Standalone connector'
    ]);
  });
});
