import { describe, expect, test } from 'bun:test';
import {
  ALL_CODEX_CONNECTORS,
  ALL_CODEX_MACHINES,
  buildCodexSessionListViewModel,
  codexSessionStatusPresentation,
  UNGROUPED_CODEX_CONNECTORS
} from '../src/features/codex-sessions/codex-session-list-model';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';
import type {
  ConnectorEnvironmentKind,
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

function connector({
  channel = 'stable',
  environment,
  id,
  label,
  status = 'online'
}: {
  channel?: 'dev' | 'stable';
  environment?: ConnectorEnvironmentKind;
  id: string;
  label?: string;
  status?: MachineRecord['connector']['status'];
}): MachineRecord {
  return {
    connector: {
      installCommand: 'project connector install',
      profile: channel === 'dev' ? { channel: 'dev', source: 'source' } : undefined,
      status
    },
    environment: environment ? { kind: environment, ...(label ? { label } : {}) } : undefined,
    id,
    kind: 'connector',
    name: `connector-${id}`,
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function physicalMachine(id: string, connectorIds: string[]): PhysicalMachineRecord {
  return { connectorIds, id, name: id };
}

function codexMachine(id: string, status: CodexMachine['status'] = 'connected'): CodexMachine {
  return { id, name: id, status };
}

function session({
  cwd = '/Users/oli/projects/project-space',
  machineId = 'mac-stable',
  status = 'idle',
  threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a',
  title = '#269 · Corran-RSPW7C · Redesign Codex task list and chat'
}: Partial<CodexSession> = {}): CodexSession {
  return {
    cwd,
    lastActivityAt: '2026-07-17T10:00:00.000Z',
    loadedByProjectSpace: true,
    machineId,
    projectName: 'display-name-is-not-identity',
    status,
    stored: true,
    threadId,
    title
  };
}

const connectors = [
  connector({ environment: 'macos', id: 'mac-stable', status: 'local' }),
  connector({ environment: 'windows', id: 'windows-stable' }),
  connector({ channel: 'dev', environment: 'wsl', id: 'wsl-dev', label: 'Ubuntu' })
];

const physicalMachines = [
  physicalMachine('os-macbook', ['mac-stable']),
  physicalMachine('os-pc', ['windows-stable', 'wsl-dev'])
];

const projects: ProjectSpaceRecord[] = [{
  id: 'connector-project:mac:project-space',
  kind: 'standalone',
  machineId: 'mac-stable',
  name: 'project-space',
  rootPath: '/Users/oli/projects/project-space'
}, {
  id: 'connector-project:windows:project-space',
  kind: 'standalone',
  machineId: 'windows-stable',
  name: 'project-space',
  rootPath: 'C:\\Users\\oli\\projects\\project-space'
}, {
  id: 'connector-project:wsl:project-space',
  kind: 'standalone',
  machineId: 'wsl-dev',
  name: 'project-space',
  rootPath: '/home/oli/projects/project-space'
}];

function viewModel(overrides: Partial<Parameters<typeof buildCodexSessionListViewModel>[0]> = {}) {
  return buildCodexSessionListViewModel({
    connectorInstallations: connectors,
    loadingMachineIds: [],
    machines: connectors.map((entry) => codexMachine(entry.id)),
    physicalMachines,
    projects,
    query: '',
    selectedConnectorKey: ALL_CODEX_CONNECTORS,
    selectedMachineKey: ALL_CODEX_MACHINES,
    sessions: [
      session(),
      session({
        cwd: 'C:\\Users\\oli\\projects\\project-space',
        machineId: 'windows-stable',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b',
        title: '#260 · Polish Codex tool rows'
      }),
      session({
        cwd: '/home/oli/projects/.worktrees/project-space/issue-262',
        machineId: 'wsl-dev',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9c',
        title: '#262 · Build Codex machine-task core'
      })
    ],
    ...overrides
  });
}

describe('Codex task list machine and connector filters', () => {
  test('presents physical machines first and connector installations second', () => {
    const all = viewModel();

    expect(all.machineOptions.map((option) => option.label)).toEqual([
      'All',
      'os-macbook',
      'os-pc'
    ]);
    expect(all.connectorOptions.map((option) => ({
      label: option.label,
      location: option.location,
      machine: option.machineLabel
    }))).toEqual([
      { label: 'All connectors', location: undefined, machine: undefined },
      { label: 'macOS · Stable connector', location: 'Local', machine: 'os-macbook' },
      { label: 'Windows · Stable connector', location: 'Remote', machine: 'os-pc' },
      { label: 'WSL · Ubuntu · Dev connector', location: 'Remote', machine: 'os-pc' }
    ]);

    const pc = viewModel({ selectedMachineKey: 'physical-machine:os-pc' });
    expect(pc.connectorOptions.map((option) => option.label)).toEqual([
      'All connectors',
      'Windows · Stable connector',
      'WSL · Ubuntu · Dev connector'
    ]);
    expect(pc.resultCount).toBe(2);
  });

  test('filters tasks by the exact selected connector id and keeps project grouping', () => {
    const model = viewModel({
      selectedConnectorKey: 'connector:wsl-dev',
      selectedMachineKey: 'physical-machine:os-pc'
    });

    expect(model.projectGroups.map((group) => [
      group.label,
      group.sessions.map((entry) => [entry.machineId, entry.threadId])
    ])).toEqual([[
      'project-space',
      [['wsl-dev', '019f5a78-3c4c-7082-bb45-5411be7d9b9c']]
    ]]);
  });

  test('resets an incompatible connector filter when the machine scope changes', () => {
    const model = viewModel({
      selectedConnectorKey: 'connector:wsl-dev',
      selectedMachineKey: 'physical-machine:os-macbook'
    });

    expect(model.normalizedConnectorKey).toBe(ALL_CODEX_CONNECTORS);
    expect(model.projectGroups[0]?.sessions.map((entry) => entry.machineId)).toEqual(['mac-stable']);
  });

  test('keeps conflicting or unknown connector membership ungrouped', () => {
    const unknown = connector({ id: 'same-name', status: 'offline' });
    const model = viewModel({
      connectorInstallations: [unknown],
      machines: [codexMachine(unknown.id, 'offline')],
      physicalMachines: [physicalMachine('a', [unknown.id]), physicalMachine('b', [unknown.id])],
      projects: [],
      sessions: [session({ machineId: unknown.id })]
    });

    expect(model.machineOptions.map((option) => option.key)).toEqual([
      ALL_CODEX_MACHINES,
      UNGROUPED_CODEX_CONNECTORS
    ]);
    expect(model.projectGroups[0]?.label).toBe('Other');
  });

  test('keeps a remembered unavailable connector under its physical machine', () => {
    const model = viewModel({
      connectorInstallations: [],
      machines: [],
      physicalMachines: [physicalMachine('os-macbook', ['missing-stable'])],
      projects: [],
      sessions: [session({ machineId: 'missing-stable' })]
    });

    expect(model.machineOptions.map((option) => ({
      availability: option.availability,
      connectorIds: option.connectorIds,
      key: option.key
    }))).toEqual([{
      availability: 'unavailable',
      connectorIds: ['missing-stable'],
      key: ALL_CODEX_MACHINES
    }, {
      availability: 'unavailable',
      connectorIds: ['missing-stable'],
      key: 'physical-machine:os-macbook'
    }]);
    expect(model.connectorOptions.map((option) => ({
      availability: option.availability,
      connectorId: option.connectorId,
      machine: option.machineLabel
    }))).toEqual([{
      availability: 'unavailable',
      connectorId: undefined,
      machine: undefined
    }, {
      availability: 'unavailable',
      connectorId: 'missing-stable',
      machine: 'os-macbook'
    }]);
    expect(model.machineOptions.some((option) => option.key === UNGROUPED_CODEX_CONNECTORS)).toBe(false);
  });

  test('fails conflicting remembered unavailable connector membership closed', () => {
    const model = viewModel({
      connectorInstallations: [],
      machines: [],
      physicalMachines: [
        physicalMachine('os-macbook', ['missing-stable']),
        physicalMachine('os-pc', ['missing-stable'])
      ],
      projects: [],
      sessions: [session({ machineId: 'missing-stable' })]
    });

    expect(model.machineOptions.map((option) => option.key)).toEqual([
      ALL_CODEX_MACHINES,
      UNGROUPED_CODEX_CONNECTORS
    ]);
    expect(model.machineOptions[1]?.connectorIds).toEqual(['missing-stable']);
    expect(model.connectorOptions[1]).toMatchObject({
      availability: 'unavailable',
      connectorId: 'missing-stable',
      machineLabel: 'Ungrouped'
    });
  });

  test('composes search with topology labels and preserves cross-connector identity', () => {
    const sharedThread = '019f5a78-3c4c-7082-bb45-5411be7d9b9f';
    const model = viewModel({
      query: 'os-pc',
      sessions: [
        session({
          cwd: 'C:\\Users\\oli\\projects\\project-space',
          machineId: 'windows-stable',
          threadId: sharedThread
        }),
        session({ cwd: '/home/oli/projects/project-space', machineId: 'wsl-dev', threadId: sharedThread }),
        session({ machineId: 'mac-stable', threadId: sharedThread })
      ]
    });

    expect(model.projectGroups[0]?.sessions.map((entry) => [entry.machineId, entry.threadId])).toEqual([
      ['windows-stable', sharedThread],
      ['wsl-dev', sharedThread]
    ]);
  });
});

describe('Codex task row status presentation', () => {
  test('keeps attention, connector availability, and checking states explicit', () => {
    expect(codexSessionStatusPresentation({
      checking: false,
      machine: codexMachine('mac-stable', 'offline'),
      session: { ...session(), attention: 'approval' }
    })).toEqual({ indicator: 'dot', label: 'Approval · Offline' });
    expect(codexSessionStatusPresentation({
      checking: true,
      machine: codexMachine('mac-stable'),
      session: { ...session(), attention: 'input' }
    })).toEqual({ indicator: 'spinner', label: 'Input · Checking' });
    expect(codexSessionStatusPresentation({
      checking: false,
      machine: codexMachine('mac-stable'),
      session: session({ status: 'active' })
    })).toEqual({ indicator: 'spinner', label: 'Working' });
  });
});
