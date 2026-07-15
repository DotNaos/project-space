import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import type { ProjectTopologyCanvasAdapterProps } from '../../src/features/project-topology/project-topology-command-center';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import {
  topologyTaskId,
  type ProjectTopologyReadState,
  type TopologyTask
} from '../../src/features/project-topology/project-topology-types';
import { topologyTaskWorkspace } from '../../src/features/project-topology/project-topology-view-model';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/api/codex-sessions-client', () => ({
  createCodexSessionsClient: () => ({})
}));

mock.module('@/api/project-space-client', () => ({
  isProjectSpaceApiRequestAllowed: () => true,
  projectSpaceClient: {},
  refreshProjectSpaceAuthToken: () => null,
  resolveProjectSpaceApiBaseUrl: () => 'http://localhost'
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({
    children,
    fullWidth: _fullWidth,
    isDisabled,
    isIconOnly: _isIconOnly,
    onPress,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    fullWidth?: boolean;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    onPress?(): void;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
  Chip: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('span', props, children)
  ),
  ScrollShadow: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  Surface: ({
    children,
    variant: _variant,
    ...props
  }: { children?: ReactNode; variant?: string; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  Tab: ({ children, id, ...props }: { children?: ReactNode; id: string; [key: string]: unknown }) => (
    createElement('button', { ...props, 'data-tab-id': id }, children)
  ),
  TabIndicator: () => createElement('span', { 'data-tab-indicator': true }),
  TabList: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  Tabs: ({
    children,
    onSelectionChange: _onSelectionChange,
    selectedKey: _selectedKey,
    ...props
  }: {
    children?: ReactNode;
    onSelectionChange?(key: string): void;
    selectedKey?: string;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  Text: ({
    as: Component = 'span',
    children,
    ...props
  }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(Component, props, children)
}));

const { TopologyTaskNodeBody } = await import('../../src/features/project-topology/project-topology-node-bodies');
const {
  handleTopologyTaskWorkspaceDialogKeyDown,
  TopologyTaskCommandCenter
} = await import('../../src/features/project-topology/project-topology-task-workspace');
const { ProjectTopologyCommandCenter } = await import(
  '../../src/features/project-topology/project-topology-command-center'
);
const { ProjectTopologyFocusPanel } = await import(
  '../../src/features/project-topology/project-topology-focus-panel'
);
const { ProjectTopologyRoutePending } = await import(
  '../../src/features/project-topology/project-topology-route-pending'
);
const { ProjectTopologyProductionRoute } = await import(
  '../../src/features/project-topology/project-topology-production-route'
);
function renderableTopology(canWrite: boolean) {
  const candidate = session(
    'machine-a',
    'thread-a',
    '/worktrees/project-space/issue-177-topology',
    'idle'
  );
  const taskId = topologyTaskId(candidate.machineId, candidate.id);
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
    },
    conversations: {
      [taskId]: {
        checkedAt,
        data: {
          openedReadOnly: true,
          session: candidate,
          turns: [{
            id: 'turn-a',
            items: [{
              id: 'user-a',
              kind: 'user-message',
              text: 'Please verify the focused view.'
            }, {
              id: 'agent-a',
              kind: 'agent-message',
              text: 'I am checking the real topology evidence.'
            }, {
              detail: 'bun test src/features/project-topology',
              id: 'command-a',
              kind: 'command',
              status: 'completed',
              text: 'Ran focused tests'
            }],
            status: 'completed'
          }]
        },
        state: 'ready'
      }
    },
    worktreesByProject: {
      'project-a': worktrees('/projects/project-space', [{
        branchName: 'issue-177-topology',
        id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
        path: '/worktrees/project-space/issue-177-topology'
      }])
    },
    writeCapabilities: canWrite ? { [taskId]: writable(candidate) } : undefined
  })));
}

function renderableTask(canWrite: boolean) {
  return renderableTopology(canWrite).projects[0]!.machines[0]!.tasks[0]!;
}

function topologyController(state: ProjectTopologyReadState) {
  return {
    getSelectedTask: () => undefined,
    getState: () => state,
    refresh: async () => state,
    selectTask: async () => state,
    subscribe: () => () => undefined
  };
}

function FakeCanvas({
  layout,
  renderNode
}: ProjectTopologyCanvasAdapterProps) {
  return createElement('div', { 'data-testid': 'fake-topology-canvas' }, layout.nodes.map((node) => (
    createElement('div', { key: node.id }, renderNode(node))
  )));
}

const navigation = {
  openCoordinator: () => undefined,
  openIssue: () => undefined,
  resetFocus: () => undefined
};

function renderCommandCenter(state: ProjectTopologyReadState) {
  return renderToStaticMarkup(
    <ProjectTopologyCommandCenter
      Canvas={FakeCanvas}
      controller={topologyController(state)}
      navigation={navigation}
      viewport={{ height: 900, width: 1280 }}
    />
  );
}

describe('project topology presentation components', () => {
  test('mounts the route without inventing portfolio data', () => {
    const html = renderToStaticMarkup(<ProjectTopologyRoutePending hasBottomTabBar />);

    expect(html).toContain('data-testid="project-topology-route"');
    expect(html).toContain('Checking portfolio data');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('No active tasks');
  });

  test('keeps the production route pending until its real viewport is measured', () => {
    const html = renderToStaticMarkup(
      <ProjectTopologyProductionRoute navigation={navigation} />
    );

    expect(html).toContain('data-testid="project-topology-production-route"');
    expect(html).toContain('Checking portfolio data');
    expect(html).not.toContain('data-testid="project-topology-command-center"');
  });

  test('renders blocked, refreshing, and stale read states without replacing truth with zero', () => {
    const topology = renderableTopology(false);
    const blocked = renderCommandCenter({
      reason: 'Machine inventory is unreachable.',
      state: 'blocked'
    });
    const checking = renderCommandCenter({ previous: topology, state: 'checking' });
    const stale = renderCommandCenter({
      failedAt: checkedAt,
      reason: 'Connector disconnected during refresh.',
      snapshot: topology,
      state: 'stale'
    });

    expect(blocked).toContain('Portfolio data is unavailable');
    expect(blocked).toContain('Machine inventory is unreachable.');
    expect(blocked).not.toContain('fake-topology-canvas');
    expect(checking).toContain('fake-topology-canvas');
    expect(checking).toContain('Refreshing portfolio data');
    expect(checking).toContain('data-testid="project-topology-refresh"');
    expect(checking).toContain('disabled=""');
    expect(checking.match(/animate-spin/g)).toHaveLength(2);
    expect(stale).toContain('fake-topology-canvas');
    expect(stale).toContain('Connector disconnected during refresh.');
    expect(`${blocked}${checking}${stale}`).not.toContain('0 active tasks');
  });

  test('composes the real hierarchy through a canvas-only adapter', () => {
    const topology = renderableTopology(false);
    const html = renderCommandCenter({ snapshot: topology, state: 'ready' });

    expect(html).toContain('data-testid="project-topology-command-center"');
    expect(html).toContain('data-testid="fake-topology-canvas"');
    expect(html).toContain('data-topology-node-body="lead"');
    expect(html).toContain('data-topology-node-body="project"');
    expect(html).toContain('data-topology-node-body="machine"');
    expect(html).toContain('data-topology-node-body="task"');
    expect(html).toContain('aria-label="Open portfolio coordination"');
    expect(html).toContain('aria-label="Open project-space project room"');
    expect(html).toContain('data-testid="project-topology-refresh"');
    expect(html).not.toContain('Chat with Lead');
    expect(html).not.toContain('data-topology-composer');
  });

  test('drills into real issues, branches, worktrees, machines, and task ownership', () => {
    const topology = renderableTopology(false);
    const project = topology.projects[0]!;
    const html = renderToStaticMarkup(
      <ProjectTopologyFocusPanel
        hasBottomTabBar
        onFocusMachine={() => undefined}
        onFocusOverview={() => undefined}
        onFocusProject={() => undefined}
        onOpenIssue={() => undefined}
        onOpenProjectConversation={() => undefined}
        onOpenTask={() => undefined}
        snapshot={topology}
        target={{ kind: 'project', projectId: project.id }}
      />
    );

    expect(html).toContain('data-testid="project-topology-focus-panel"');
    expect(html).toContain('#177');
    expect(html).toContain('Introduce Lead and Project Lead coordination workflow');
    expect(html).toContain('issue-177-topology');
    expect(html).toContain('machine-a');
    expect(html).toContain('Fayn-EVT6AF');
    expect(html).toContain('aria-label="Open project-space project room"');
    expect(html).toContain('6.75rem');
    expect(html).not.toContain('/worktrees/project-space/issue-177-topology');
  });

  test('uses a dedicated compact detail region and explains stale evidence once', () => {
    const topology = renderableTopology(false);
    const project = topology.projects[0]!;
    const staleProject = {
      ...project,
      branches: {
        ...project.branches,
        reason: 'Portfolio data is refreshing.',
        state: 'stale' as const
      },
      inventory: {
        checkedAt,
        reason: 'Portfolio data is refreshing.',
        state: 'stale' as const
      },
      issues: {
        ...project.issues,
        reason: 'Portfolio data is refreshing.',
        state: 'stale' as const
      }
    };
    const html = renderToStaticMarkup(
      <ProjectTopologyFocusPanel
        hasBottomTabBar
        onFocusMachine={() => undefined}
        onFocusOverview={() => undefined}
        onFocusProject={() => undefined}
        onOpenIssue={() => undefined}
        onOpenProjectConversation={() => undefined}
        onOpenTask={() => undefined}
        placement="inline"
        snapshot={{ ...topology, projects: [staleProject] }}
        target={{ kind: 'project', projectId: project.id }}
      />
    );

    expect(html).toContain('data-placement="inline"');
    expect(html).toContain('relative size-full rounded-none');
    expect(html).not.toContain('absolute inset-x-2');
    expect(html.match(/Portfolio data is refreshing\./g)).toHaveLength(1);
    expect(html.match(/Last safe/g)).toHaveLength(2);
  });

  test('renders a compact real task cell without a fabricated browser frame', () => {
    const html = renderToStaticMarkup(
      <TopologyTaskNodeBody onOpen={() => undefined} task={renderableTask(false)} />
    );

    expect(html).toContain('#177');
    expect(html).toContain('Introduce Lead and Project Lead coordination workflow');
    expect(html).toContain('issue-177-topology');
    expect(html).toContain('I am checking the real topology evidence.');
    expect(html).toContain('Browser unavailable');
    expect(html).not.toContain('<iframe');
  });

  test('shows ordered history and a composer only for proven write authority', () => {
    const writableTask = renderableTask(true);
    const writableHtml = renderToStaticMarkup(
      <TopologyTaskCommandCenter
        onClose={() => undefined}
        onSend={() => undefined}
        task={writableTask}
        view={topologyTaskWorkspace(writableTask, {
          actionsAvailable: true,
          viewportWidth: 390
        })}
      />
    );
    const readonlyTask = renderableTask(false);
    const readonlyHtml = renderToStaticMarkup(
      <TopologyTaskCommandCenter
        onClose={() => undefined}
        task={readonlyTask}
        view={topologyTaskWorkspace(readonlyTask, {
          actionsAvailable: true,
          viewportWidth: 1400
        })}
      />
    );

    expect(writableHtml.indexOf('Please verify the focused view.')).toBeLessThan(
      writableHtml.indexOf('I am checking the real topology evidence.')
    );
    expect(writableHtml).toContain('Ran focused tests');
    expect(writableHtml).toContain('data-topology-composer="writable"');
    expect(writableHtml).toContain('Send follow-up to this Codex task');
    expect(writableHtml).toContain('model is read-only');
    expect(writableHtml).toContain('role="dialog"');
    expect(writableHtml).toContain('aria-modal="true"');
    expect(writableHtml).toContain('data-topology-dialog-initial-focus="true"');
    expect(writableHtml).toContain('aria-labelledby="task:machine-a:thread-a-command-center-title"');
    expect(writableHtml).toContain('id="task:machine-a:thread-a-command-center-title"');
    expect(readonlyHtml).toContain('data-topology-composer="unavailable"');
    expect(readonlyHtml).toContain('No current existing-task write capability has been proven.');
    expect(readonlyHtml).not.toContain('data-topology-composer="writable"');
    expect(readonlyHtml).not.toContain('<textarea');
  });

  test('keeps keyboard focus bounded and closes the dialog with Escape', () => {
    let closeCount = 0;
    let dialogFocusCount = 0;
    let firstFocusCount = 0;
    let lastFocusCount = 0;
    const first = { focus: () => { firstFocusCount += 1; } } as HTMLElement;
    const last = { focus: () => { lastFocusCount += 1; } } as HTMLElement;
    const dialog = {
      contains: (element: Element | null) => element === first || element === last,
      focus: () => { dialogFocusCount += 1; },
      querySelectorAll: () => [first, last]
    } as unknown as HTMLElement;
    const keyEvent = (key: string, shiftKey = false) => {
      const counts = { prevented: 0, stopped: 0 };
      return {
        counts,
        event: {
          defaultPrevented: false,
          key,
          preventDefault: () => { counts.prevented += 1; },
          shiftKey,
          stopPropagation: () => { counts.stopped += 1; }
        } as Parameters<typeof handleTopologyTaskWorkspaceDialogKeyDown>[0]
      };
    };

    const forward = keyEvent('Tab');
    handleTopologyTaskWorkspaceDialogKeyDown(forward.event, dialog, last, () => undefined);
    expect(firstFocusCount).toBe(1);
    expect(forward.counts.prevented).toBe(1);

    const backward = keyEvent('Tab', true);
    handleTopologyTaskWorkspaceDialogKeyDown(backward.event, dialog, first, () => undefined);
    expect(lastFocusCount).toBe(1);
    expect(backward.counts.prevented).toBe(1);

    const escape = keyEvent('Escape');
    handleTopologyTaskWorkspaceDialogKeyDown(escape.event, dialog, first, () => { closeCount += 1; });
    expect(closeCount).toBe(1);
    expect(escape.counts).toEqual({ prevented: 1, stopped: 1 });

    const emptyDialog = { ...dialog, querySelectorAll: () => [] } as unknown as HTMLElement;
    const empty = keyEvent('Tab');
    handleTopologyTaskWorkspaceDialogKeyDown(empty.event, emptyDialog, null, () => undefined);
    expect(dialogFocusCount).toBe(1);
    expect(empty.counts.prevented).toBe(1);
  });

  test('renders only proven browser and developer-tool capabilities', () => {
    const base = renderableTask(false);
    const task: TopologyTask = {
      ...base,
      browser: {
        checkedAt,
        frameUrl: '/safe/browser/frame',
        interaction: 'read-only',
        machineId: base.machineId,
        sessionId: 'browser-a',
        state: 'ready',
        threadId: base.threadId,
        tools: {
          console: { checkedAt, streamUrl: '/safe/browser/console' }
        }
      }
    };
    const html = renderToStaticMarkup(
      <TopologyTaskCommandCenter
        eventsByTool={{ console: ['A real console event'] }}
        onClose={() => undefined}
        task={task}
        view={topologyTaskWorkspace(task, {
          actionsAvailable: false,
          viewportWidth: 1400
        })}
      />
    );

    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=""');
    expect(html).toContain('data-browser-input="blocked"');
    expect(html).toContain('A real console event');
    expect(html).toContain('>Console<');
    expect(html).not.toContain('>Network<');
    expect(html).not.toContain('>Logs<');
  });
});
