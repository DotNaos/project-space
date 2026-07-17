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

  test('reports offline, incapable, stale, and unauthorized targets honestly', () => {
    const cases: Array<[MachineRecord, CodexMachineTaskTargetError['reason']]> = [
      [connector('mac-local', { connector: { installCommand: '', status: 'offline' } }), 'offline'],
      [connector('mac-local', {
        connector: { capabilities: [], installCommand: '', status: 'online' }
      }), 'offline'],
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
      connectors: [connector('mac-local')],
      generationFor: () => 9,
      physicalMachineId: 'physical-local',
      physicalMachines,
      userCanUseConnector: () => false
    })).toThrow(expect.objectContaining({ reason: 'unauthorized' }));
  });
});
