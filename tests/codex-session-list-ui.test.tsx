import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ALL_CODEX_CONNECTORS,
  ALL_CODEX_MACHINES
} from '../src/features/codex-sessions/codex-session-list-model';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';
import type {
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  SearchField: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  SearchFieldInput: (props: Record<string, unknown>) => createElement('input', props),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children),
  ToggleButton: ({ children, id, variant: _variant, ...props }: {
    children?: ReactNode;
    id: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', { ...props, 'data-id': id }, children),
  ToggleButtonGroup: ({
    children,
    disallowEmptySelection: _disallowEmptySelection,
    isDetached: _isDetached,
    onSelectionChange: _onSelectionChange,
    selectedKeys: _selectedKeys,
    selectionMode: _selectionMode,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('div', props, children)
}));

mock.module('@heroui/react', () => ({
  Spinner: (props: Record<string, unknown>) => createElement('span', { ...props, 'data-spinner': true })
}));

const { CodexSessionList } = await import(
  '../src/features/codex-sessions/codex-session-list'
);

const connector: MachineRecord = {
  connector: {
    installCommand: 'project connector install',
    profile: { channel: 'dev', source: 'source' },
    status: 'online'
  },
  environment: { kind: 'wsl', label: 'Ubuntu' },
  id: 'connector-wsl-dev',
  kind: 'connector',
  name: 'os-pc-wsl-dev',
  network: {},
  roles: ['connector'],
  sourcePath: 'connector-hub'
};

const physicalMachine: PhysicalMachineRecord = {
  connectorIds: [connector.id],
  id: 'physical-os-pc',
  name: 'os-pc'
};

const machine: CodexMachine = {
  id: connector.id,
  name: connector.name,
  status: 'connected'
};

const project: ProjectSpaceRecord = {
  id: 'connector-project:wsl:project-space',
  kind: 'standalone',
  machineId: connector.id,
  name: 'project-space',
  rootPath: '/home/oli/projects/project-space'
};

const session: CodexSession = {
  cwd: '/home/oli/projects/.worktrees/project-space/issue-269',
  lastActivityAt: '2026-07-17T10:00:00.000Z',
  loadedByProjectSpace: true,
  machineId: connector.id,
  status: 'idle',
  stored: true,
  threadId: '019f6f94-2b97-7d21-bb83-8d43bf620439',
  title: '#269 · Corran-RSPW7C · Redesign Codex task list and chat with a deliberately long title that must truncate'
};

describe('Codex task list presentation', () => {
  test('renders two accessible filter layers and project-grouped flat task rows', () => {
    const html = renderToStaticMarkup(
      <CodexSessionList
        connectorInstallations={[connector]}
        loadingMachineIds={[]}
        machines={[machine]}
        now={new Date('2026-07-17T10:05:00.000Z')}
        onSelect={() => {}}
        onSelectConnector={() => {}}
        onSelectMachine={() => {}}
        physicalMachines={[physicalMachine]}
        projects={[project]}
        query=""
        selectedConnectorKey={ALL_CODEX_CONNECTORS}
        selectedMachineKey={ALL_CODEX_MACHINES}
        selectedOrigin={{ machineId: session.machineId, threadId: session.threadId }}
        sessions={[session]}
        setQuery={() => {}}
      />
    );

    expect(html).toContain('aria-label="Machines filter"');
    expect(html).toContain('aria-label="Connectors filter"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('WSL · Ubuntu · Dev connector');
    expect(html).toContain('Remote');
    expect(html).toContain('>Projects<');
    expect(html).toContain('>project-space<');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="block truncate');
    expect(html).toContain(`title="${session.title}"`);
    expect(html).toContain(`Open task ${session.title}. Idle.`);
  });

  test('keeps offline attention and empty filtered states honest', () => {
    const html = renderToStaticMarkup(
      <CodexSessionList
        connectorInstallations={[{ ...connector, connector: { ...connector.connector, status: 'offline' } }]}
        loadingMachineIds={[]}
        machines={[{ ...machine, status: 'offline' }]}
        now={new Date('2026-07-17T10:05:00.000Z')}
        onSelect={() => {}}
        onSelectConnector={() => {}}
        onSelectMachine={() => {}}
        physicalMachines={[physicalMachine]}
        projects={[project]}
        query="does-not-exist"
        selectedConnectorKey={ALL_CODEX_CONNECTORS}
        selectedMachineKey={ALL_CODEX_MACHINES}
        sessions={[{ ...session, attention: 'approval' }]}
        setQuery={() => {}}
      />
    );

    expect(html).toContain('No tasks match');
    expect(html).toContain('Offline');
    expect(html).not.toContain('aria-current="page"');
  });
});
