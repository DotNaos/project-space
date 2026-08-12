import { describe, expect, test } from 'bun:test';

import {
  CodexMachineTaskTargetError,
  resolveCodexMachineTaskTarget
} from '../server/codex-machine-tasks/target-resolver';
import { CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY } from '../src/shared/codex-machine-tasks-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../src/shared/project-space-api';

function connector(id: string, overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    connector: {
      capabilities: [CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY],
      installCommand: '',
      status: 'online'
    },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: [],
    sourcePath: '',
    ...overrides
  };
}

const physicalMachines: PhysicalMachineRecord[] = [
  { connectorIds: ['mac-local'], id: 'physical-local', name: 'os-macbook' },
  { connectorIds: ['pc-windows', 'pc-wsl'], id: 'physical-pc', name: 'os-pc' }
];

describe('Codex machine-task target resolution', () => {
  test('targets a provider-managed environment without inventing a physical host', () => {
    expect(resolveCodexMachineTaskTarget({
      computeInventory: {
        connectors: [{
          associatedAt: '2026-08-08T00:00:00.000Z',
          connectorId: 'codespace-one',
          environmentId: 'environment-codespace'
        }],
        environments: [{
          hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
          id: 'environment-codespace',
          identity: { key: 'environment:codespace01234567', version: 1 },
          kind: 'github_codespace',
          name: 'project-space / issue-464',
          platformId: 'platform-codespaces',
          resourceMode: 'dedicated'
        }],
        hosts: [],
        platforms: [{ id: 'platform-codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }],
        violations: []
      },
      connectors: [connector('codespace-one')],
      environmentId: 'environment-codespace',
      generationFor: () => 11,
      physicalMachines
    })).toEqual({
      connector: { generation: 11, id: 'codespace-one', name: 'codespace-one' },
      environment: { id: 'environment-codespace', name: 'project-space / issue-464' },
      physicalMachine: { id: 'environment-codespace', name: 'project-space / issue-464' }
    });
  });

  test('selects the only eligible connector on an exact physical machine', () => {
    expect(resolveCodexMachineTaskTarget({
      connectors: [connector('mac-local'), connector('pc-windows'), connector('pc-wsl')],
      generationFor: () => 7,
      physicalMachineId: 'physical-local',
      physicalMachines
    })).toEqual({
      connector: { generation: 7, id: 'mac-local', name: 'mac-local' },
      physicalMachine: { id: 'physical-local', name: 'os-macbook' }
    });
  });

  test('requires an exact connector when multiple eligible installations exist', () => {
    expect(() => resolveCodexMachineTaskTarget({
      connectors: [connector('pc-windows'), connector('pc-wsl')],
      generationFor: () => 8,
      physicalMachineName: 'os-pc',
      physicalMachines
    })).toThrow(expect.objectContaining({ reason: 'connector_required' }));

    expect(resolveCodexMachineTaskTarget({
      connectorId: 'pc-wsl',
      connectors: [connector('pc-windows'), connector('pc-wsl', {
        environment: { kind: 'wsl', label: 'Stable' }
      })],
      generationFor: () => 8,
      physicalMachineName: 'os-pc',
      physicalMachines
    }).connector).toEqual({
      environment: 'Stable',
      generation: 8,
      id: 'pc-wsl',
      name: 'pc-wsl'
    });
  });

  test('fails closed when the connector has conflicting physical identities', () => {
    expect(() => resolveCodexMachineTaskTarget({
      connectorId: 'mac-local',
      connectors: [connector('mac-local')],
      generationFor: () => 7,
      physicalMachineId: 'physical-local',
      physicalMachines: [
        ...physicalMachines,
        { connectorIds: ['mac-local'], id: 'physical-duplicate', name: 'duplicate' }
      ]
    })).toThrow(expect.objectContaining({ reason: 'connector_required' }));
  });

  test('reports offline, incapable, stale, and unauthorized targets honestly', () => {
    const cases: Array<[MachineRecord, CodexMachineTaskTargetError['reason']]> = [
      [connector('mac-local', { connector: { installCommand: '', status: 'offline' } }), 'offline'],
      [connector('mac-local', {
        connector: { capabilities: [], installCommand: '', status: 'online' }
      }), 'machine_not_ready'],
      [connector('mac-local'), 'stale_connector']
    ];

    for (const [candidate, reason] of cases) {
      expect(() => resolveCodexMachineTaskTarget({
        connectors: [candidate],
        generationFor: () => reason === 'stale_connector' ? undefined : 9,
        physicalMachineId: 'physical-local',
        physicalMachines
      })).toThrow(expect.objectContaining({ reason }));
    }

    expect(() => resolveCodexMachineTaskTarget({
      connectors: [connector('mac-local', {
        connector: { capabilities: [], installCommand: '', status: 'online' }
      })],
      generationFor: () => 9,
      physicalMachineId: 'physical-local',
      physicalMachines
    })).toThrow('project doctor --machine-id physical-local');

    expect(() => resolveCodexMachineTaskTarget({
      connectors: [connector('mac-local')],
      generationFor: () => 9,
      physicalMachineId: 'physical-local',
      physicalMachines,
      userCanUseConnector: () => false
    })).toThrow(expect.objectContaining({ reason: 'unauthorized' }));
  });

  test('blocks a live task session while its signed connector update is pending', () => {
    const candidate = connector('mac-local', { connector: {
      capabilities: [CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY, 'runtime.update'],
      installCommand: '',
      runtime: {
        architecture: 'arm64',
        buildId: '0'.repeat(40),
        bundleVersions: {
          connector: '0.4.0', machineTools: '0.4.0', projectCli: '0.4.0'
        },
        channel: 'stable',
        instanceId: 'runtime-before',
        lastCheckedAt: '2026-08-10T00:00:00.000Z',
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'v0.4.0',
        source: 'managed',
        version: '0.4.0'
      },
      status: 'online'
    } });
    const runtimeStatuses = new Map([['mac-local', {
      capabilities: candidate.connector.capabilities!,
      machineId: 'mac-local',
      online: true,
      runtime: candidate.connector.runtime,
      update: {
        availableReleaseId: 'v0.5.0',
        availableVersion: '0.5.0',
        state: 'update-available' as const
      }
    }]]);

    expect(() => resolveCodexMachineTaskTarget({
      connectors: [candidate],
      generationFor: () => 9,
      physicalMachineId: 'physical-local',
      physicalMachines,
      runtimeStatuses
    })).toThrow(expect.objectContaining({ reason: 'machine_not_ready' }));
  });
});
