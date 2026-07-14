import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
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

const { ProjectHomeCommandCenter } = await import(
  '../../src/features/project-topology/project-home-command-center'
);
const { ProjectChatCommandCenter } = await import(
  '../../src/features/project-topology/project-chat-command-center'
);

describe('Project Space command-center composition', () => {
  test('makes the map the default Home view and keeps the compact summary available', () => {
    const html = renderToStaticMarkup(
      <ProjectHomeCommandCenter
        map={<div>Portfolio map</div>}
        summary={<div>Compact project summary</div>}
      />
    );

    expect(html).toContain('data-testid="project-home-command-center"');
    expect(html).toContain('data-home-view="map"');
    expect(html).toContain('aria-label="Home view"');
    expect(html).toContain('>Map<');
    expect(html).toContain('>Summary<');
    expect(html).not.toContain('>Topology<');
  });

  test('renders agent conversation context inside one Chat hierarchy', () => {
    const html = renderToStaticMarkup(
      <ProjectChatCommandCenter
        onOpen={() => undefined}
        target={{
          kind: 'agent',
          projectId: 'project-space',
          projectLabel: 'Project Space',
          taskId: 'issue-177',
          taskLabel: '#177 · Fayn-EVT6AF'
        }}
      >
        <div>Existing real task conversation</div>
      </ProjectChatCommandCenter>
    );

    expect(html).toContain('data-testid="project-chat-command-center"');
    expect(html).toContain('data-chat-layer="agent"');
    expect(html.indexOf('Lead')).toBeLessThan(html.indexOf('Project Space'));
    expect(html.indexOf('Project Space')).toBeLessThan(html.indexOf('#177 · Fayn-EVT6AF'));
    expect(html).toContain('Existing real task conversation');
    expect(html).not.toContain('>Codex<');
  });
});
