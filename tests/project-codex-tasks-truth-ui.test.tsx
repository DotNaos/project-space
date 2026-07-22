import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, onPress, ...props }: {
    children?: ReactNode;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, onClick: onPress }, children),
  Chip: ({ children, ...props }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('span', props, children),
  SearchField: ({ children, ...props }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: ({ children, ...props }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  SearchFieldInput: (props: Record<string, unknown>) => createElement('input', props),
  SearchFieldSearchIcon: () => createElement('span', { 'data-search-icon': true }),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));

mock.module('@heroui/react', () => ({
  Drawer: Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    {
      Backdrop: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('div', props, children),
      Body: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('div', props, children),
      CloseTrigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('button', props, children),
      Content: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('div', props, children),
      Dialog: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('div', props, children),
      Header: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('div', props, children),
      Heading: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('h2', props, children),
      Trigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
        createElement('button', props, children)
    }
  ),
  Spinner: (props: Record<string, unknown>) => createElement(
    'span',
    { ...props, 'data-spinner': true }
  )
}));

const { ProjectCodexTasks } = await import(
  '../src/features/codex-sessions/project-codex-tasks'
);

const machine: CodexMachine = {
  id: 'machine-mac',
  inventoryState: 'live',
  name: 'os-macbook',
  status: 'connected'
};

const activeSession: CodexSession = {
  cwd: '/Users/oli/projects/project-space',
  lastActivityAt: '2026-07-13T08:59:00.000Z',
  loadedByProjectSpace: true,
  machineId: machine.id,
  model: 'gpt-5',
  projectName: 'project-space',
  status: 'active',
  stored: true,
  threadId: 'thread-149',
  title: '#149 · Integrate Codex sessions'
};

describe('Project Codex truth-gated entry points', () => {
  test('blocks a GitHub-only project after connector discovery completes', () => {
    const state = {
      activeTurnId: undefined,
      approvalBindings: {},
      conversations: [],
      inputBindings: {},
      loadingMachineIds: [],
      machines: [],
      reading: false,
      runtimeByMachineId: {},
      seenEventIds: [],
      selectedOrigin: undefined,
      sessions: []
    };
    const controller = {
      getState: () => state,
      loadMachines: async () => {},
      subscribe: () => () => {}
    } as never;
    const html = renderToStaticMarkup(
      <ProjectCodexTasks
        connectorOverview={{ machines: [], physicalMachines: [] }}
        controller={controller}
        machineIds={[]}
        mode="panel"
        now={new Date('2026-07-21T08:00:00.000Z')}
        onOpenTask={() => {}}
        projectRecords={[{
          id: 'github-project-space',
          kind: 'github',
          name: 'Project Space',
          rootPath: ''
        }]}
      />
    );

    expect(html).toContain('Blocked');
    expect(html).toContain('No authenticated connector is available for this Codex scope.');
    expect(html).not.toContain('data-spinner="true"');
    expect(html).not.toContain('0 active tasks');
  });

  test('renders the same machine-grouped canonical task in the project tab and Chat drawer', () => {
    const state = {
      activeTurnId: undefined,
      approvalBindings: {},
      conversations: [],
      inputBindings: {},
      loadingMachineIds: ['machine-loading'],
      machines: [machine, {
        id: 'machine-offline',
        inventoryState: 'stale' as const,
        name: 'os-pc',
        status: 'offline' as const
      }],
      reading: false,
      runtimeByMachineId: {},
      seenEventIds: [],
      selectedOrigin: undefined,
      sessions: [activeSession, {
        ...activeSession,
        cwd: '/srv/projects/project-space',
        machineId: 'machine-offline',
        status: 'idle' as const,
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b',
        title: 'Review idle task'
      }]
    };
    const controller = {
      getState: () => state,
      loadMachines: async () => {},
      subscribe: () => () => {}
    } as never;
    const projectRecords = [{
      id: 'project-space',
      kind: 'standalone' as const,
      machineId: machine.id,
      name: 'Project Space',
      rootPath: '/Users/oli/projects/project-space'
    }, {
      id: 'project-space-offline',
      kind: 'standalone' as const,
      machineId: 'machine-offline',
      name: 'Project Space',
      rootPath: '/srv/projects/project-space'
    }, {
      id: 'project-space-loading',
      kind: 'standalone' as const,
      machineId: 'machine-loading',
      name: 'Project Space',
      rootPath: '/opt/projects/project-space'
    }];
    const common = {
      controller,
      machineIds: [machine.id],
      onOpenTask: () => {},
      projectRecords
    };
    const panel = renderToStaticMarkup(<ProjectCodexTasks {...common} mode="panel" />);
    const preview = renderToStaticMarkup(<ProjectCodexTasks {...common} mode="preview" />);

    for (const html of [panel, preview]) {
      expect(html).toContain('os-macbook');
      expect(html).toContain('Integrate Codex sessions');
      expect(html).toContain('Issue #149');
      expect(html).toContain('data-spinner="true"');
      expect(html).toContain('Review idle task');
      expect(html).toContain('os-pc');
      expect(html).toContain('Checking machine');
      expect(html).toContain('Checking the authenticated connector and its Codex support.');
      expect(html).not.toContain('projectName');
    }
    expect(preview).toContain('Blocked Codex');
    expect(preview).not.toContain('0 active tasks');
    expect(preview).toContain('Codex tasks');
    expect(
      preview.split(
        'Only a saved Codex inventory is available; the current connector response is unproven.'
      ).length - 1
    ).toBe(1);
    expect(panel).not.toContain('Unavailable machine');
  });

  test('shows one connector error in an empty blocked Chat drawer', () => {
    const state = {
      activeTurnId: undefined,
      approvalBindings: {},
      conversations: [],
      inputBindings: {},
      loadingMachineIds: [],
      machines: [],
      reading: false,
      runtimeByMachineId: {},
      seenEventIds: [],
      selectedOrigin: undefined,
      sessions: []
    };
    const controller = {
      getState: () => state,
      loadMachines: async () => {},
      subscribe: () => () => {}
    } as never;
    const connectorOverview = {
      machines: [{
        connector: {
          capabilities: ['runtime.restart', 'runtime.update'],
          installCommand: 'project connector install',
          runtime: {
            architecture: 'arm64',
            buildId: 'build-1',
            bundleVersions: {
              connector: '0.4.9', machineTools: '0.4.9', projectCli: '0.4.9'
            },
            channel: 'stable',
            instanceId: 'instance-current',
            lastCheckedAt: '2026-07-21T08:00:00.000Z',
            platform: 'darwin',
            protocolVersion: '2',
            releaseId: 'v0.4.9',
            source: 'managed',
            version: '0.4.9'
          },
          status: 'online',
          update: {
            availableReleaseId: 'v0.4.10',
            availableVersion: '0.4.10',
            state: 'update-available'
          }
        },
        id: machine.id,
        kind: 'connector' as const,
        name: 'os-macbook',
        network: {},
        roles: ['connector'],
        sourcePath: 'connector-hub'
      }],
      physicalMachines: []
    };
    const html = renderToStaticMarkup(
      <ProjectCodexTasks
        connectorOverview={connectorOverview}
        controller={controller}
        machineIds={[machine.id]}
        mode="preview"
        onManageConnector={() => {}}
        onOpenTask={() => {}}
        projectRecords={[{
          id: 'project-space',
          kind: 'standalone',
          machineId: machine.id,
          name: 'Project Space',
          rootPath: '/Users/oli/projects/project-space'
        }]}
      />
    );

    const detail = 'This connector does not provide Codex sessions.';
    expect(html.split(detail).length - 1).toBe(1);
    expect(html.split('Manage connector').length - 1).toBe(1);
  });
});
