import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import { topologyTaskId, type TopologyTask } from '../../src/features/project-topology/project-topology-types';
import { topologyTaskWorkspace } from '../../src/features/project-topology/project-topology-view-model';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
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
const { TopologyTaskCommandCenter } = await import('../../src/features/project-topology/project-topology-task-workspace');
const { ProjectTopologyRoutePending } = await import(
  '../../src/features/project-topology/project-topology-route-pending'
);

function renderableTask(canWrite: boolean) {
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
  }))).projects[0]!.machines[0]!.tasks[0]!;
}

describe('project topology presentation components', () => {
  test('mounts the route without inventing portfolio data', () => {
    const html = renderToStaticMarkup(<ProjectTopologyRoutePending hasBottomTabBar />);

    expect(html).toContain('data-testid="project-topology-route"');
    expect(html).toContain('Checking topology evidence');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('No active tasks');
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
          viewportWidth: 1400
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
    expect(readonlyHtml).not.toContain('data-topology-composer');
    expect(readonlyHtml).not.toContain('<textarea');
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
