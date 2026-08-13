import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function passthrough({
  children,
  onSelectionChange: _onSelectionChange,
  selectedKey: _selectedKey,
  variant: _variant,
  ...props
}: {
  children?: ReactNode;
  onSelectionChange?: unknown;
  selectedKey?: unknown;
  variant?: unknown;
  [key: string]: unknown;
}) {
  return createElement('div', props, children);
}

const Tabs = Object.assign(passthrough, {
  Indicator: (props: Record<string, unknown>) => createElement('span', {
    ...props,
    'data-tab-indicator': true
  }),
  List: passthrough,
  ListContainer: passthrough,
  Tab: ({ children, id }: { children?: ReactNode; id?: string }) => (
    createElement('button', { 'data-tab': id }, children)
  )
});

mock.module('@heroui/react', () => ({ Tabs }));

const { ProjectTaskDetailTabs } = await import(
  '../src/features/project-tasks/project-task-detail-tabs'
);

describe('project task detail tabs', () => {
  test('starts with Runner and keeps every tab panel mounted', () => {
    const html = renderToStaticMarkup(
      <ProjectTaskDetailTabs
        discussion={<p>Discussion content</p>}
        pipeline={<p>Pipeline content</p>}
        resetKey={604}
        runner={<p>Runner content</p>}
      />
    );

    expect(html).toContain('data-tab="runner"');
    expect(html).toContain('data-tab="pipeline"');
    expect(html).toContain('data-tab="discussion"');
    expect(html.match(/data-tab-indicator="true"/g)).toHaveLength(3);
    expect(html).toContain('bg-current/[.045]');
    expect(html).toContain('Runner content');
    expect(html).toContain('Pipeline content');
    expect(html).toContain('Discussion content');
    expect(html).toContain('aria-label="Runner"');
    expect(html).toContain('aria-label="Pipeline" hidden=""');
    expect(html).toContain('aria-label="Discussion" hidden=""');
  });
});
