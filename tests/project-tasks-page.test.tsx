import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectTaskViewModel } from '../src/features/project-tasks/task-view-model';

function Button({ children, onPress, isIconOnly: _isIconOnly, size: _size, variant: _variant, ...props }: {
  children?: ReactNode;
  onPress?: () => void;
  [key: string]: unknown;
}) {
  return createElement('button', { ...props, onClick: onPress }, children);
}

const Tooltip = Object.assign(
  ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  {
    Content: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
    Trigger: ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  }
);

mock.module('@heroui/react', () => ({ Button, Tooltip }));

const { ProjectTasksPage } = await import('../src/features/project-tasks/project-tasks-page');

const task: ProjectTaskViewModel = {
  comments: [],
  health: 'unknown',
  issue: {
    labels: [],
    number: 722,
    parentIssue: {
      number: 721,
      title: 'Make Compute Tailscale-native',
      url: 'https://github.com/DotNaos/project-space/issues/721'
    },
    state: 'open',
    subIssueProgress: {
      completed: 2,
      percentCompleted: 33,
      total: 6
    },
    title: 'Discover and classify Environments from Tailscale',
    url: 'https://github.com/DotNaos/project-space/issues/722'
  },
  state: 'backlog'
};

describe('project tasks page', () => {
  test('shows native parent and sub-issue progress metadata', () => {
    const html = renderToStaticMarkup(
      <ProjectTasksPage
        isLoading={false}
        onNewTask={() => undefined}
        onOpenTask={() => undefined}
        onRetry={() => undefined}
        projectName="Project Space"
        tasks={[task]}
      />
    );

    expect(html).toContain('Sub-issue of #721');
    expect(html).toContain('Sub-issues 2 of 6 complete');
    expect(html).toContain('2/6');
  });
});
