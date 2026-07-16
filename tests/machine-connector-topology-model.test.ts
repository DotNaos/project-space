import { describe, expect, test } from 'bun:test';
import type {
  ConnectorEnvironmentKind,
  MachineRecord,
  PhysicalMachineRecord
} from '../src/shared/project-space-api';
import {
  connectorLocationPresentation,
  groupConnectorInstallations
} from '../src/features/project-desktop/components/machine-connector-topology-model';

function connector({
  channel = 'stable',
  environment,
  id,
  label,
  scope,
  status = 'online'
}: {
  channel?: 'dev' | 'stable';
  environment?: ConnectorEnvironmentKind;
  id: string;
  label?: string;
  scope?: string;
  status?: MachineRecord['connector']['status'];
}): MachineRecord {
  return {
    connector: {
      installCommand: 'project connector install',
      profile: channel === 'dev' ? { channel: 'dev', source: 'source' } : undefined,
      status
    },
    environment: environment ? { kind: environment, ...(label ? { label } : {}) } : undefined,
    executionScopeId: scope,
    id,
    kind: 'connector',
    name: `connector-${id}`,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function machine(id: string, connectorIds: string[]): PhysicalMachineRecord {
  return { connectorIds, id, name: id };
}

describe('machine connector topology model', () => {
  test('groups Windows Stable, WSL Stable, and WSL Dev under one explicit physical machine', () => {
    const result = groupConnectorInstallations({
      connectors: [
        connector({ environment: 'wsl', id: 'wsl-dev', label: 'Ubuntu', channel: 'dev', scope: 'wsl' }),
        connector({ environment: 'windows', id: 'windows-stable', scope: 'windows' }),
        connector({ environment: 'wsl', id: 'wsl-stable', label: 'Ubuntu', scope: 'wsl' })
      ],
      physicalMachines: [machine('os-pc', ['windows-stable', 'wsl-stable', 'wsl-dev'])]
    });

    expect(result.machines).toHaveLength(1);
    expect(result.machines[0]).toMatchObject({
      connectorCount: 3,
      environmentLabels: ['Windows', 'WSL · Ubuntu'],
      id: 'os-pc',
      onlineConnectorCount: 3
    });
    expect(result.machines[0]?.connectors.map(({ channel, executionScopeId, id }) => ({
      channel,
      executionScopeId,
      id
    }))).toEqual([
      { channel: 'stable', executionScopeId: 'windows', id: 'windows-stable' },
      { channel: 'stable', executionScopeId: 'wsl', id: 'wsl-stable' },
      { channel: 'dev', executionScopeId: 'wsl', id: 'wsl-dev' }
    ]);
  });

  test('does not infer physical membership or WSL from matching display names', () => {
    const linuxOne = connector({ environment: 'linux', id: 'one' });
    const linuxTwo = connector({ environment: 'linux', id: 'two' });
    linuxOne.name = 'os-pc-wsl';
    linuxTwo.name = 'os-pc-wsl';

    const result = groupConnectorInstallations({ connectors: [linuxOne, linuxTwo], physicalMachines: [] });

    expect(result.machines).toEqual([]);
    expect(result.ungroupedConnectors.map(({ environmentLabel, id }) => ({ environmentLabel, id }))).toEqual([
      { environmentLabel: 'Linux', id: 'one' },
      { environmentLabel: 'Linux', id: 'two' }
    ]);
  });

  test('fails conflicting membership closed and keeps missing environment honest', () => {
    const unknown = connector({ id: 'unknown', status: 'offline' });
    const result = groupConnectorInstallations({
      connectors: [unknown],
      physicalMachines: [machine('a', ['unknown']), machine('b', ['unknown'])]
    });

    expect(result.machines.every((entry) => entry.connectors.length === 0)).toBe(true);
    expect(result.ungroupedConnectors[0]).toMatchObject({ id: 'unknown', isOnline: false });
    expect(result.conflicts).toEqual([{
      connectorId: 'unknown',
      physicalMachineIds: ['a', 'b']
    }]);
  });

  test('presents selectors as physical machine first and connector environment second', () => {
    const wslDev = connector({
      channel: 'dev',
      environment: 'wsl',
      id: 'wsl-dev',
      label: 'Ubuntu',
      scope: 'wsl'
    });

    expect(connectorLocationPresentation({
      connector: wslDev,
      physicalMachines: [machine('os-pc', [wslDev.id])]
    })).toEqual({
      connectorLabel: 'WSL · Ubuntu · Dev',
      machineName: 'os-pc',
      statusLabel: 'WSL · Ubuntu · Dev · online'
    });
  });
});
