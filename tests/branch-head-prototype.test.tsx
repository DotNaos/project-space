import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: component('button'),
  Chip: component('span'),
  Text: ({
    as = 'span',
    children,
    ...props
  }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));

function component(element: ElementType) {
  return ({
    children,
    isIconOnly: _isIconOnly,
    onPress: _onPress,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(element, props, children);
}

const { BranchHeadPrototype } = await import(
  '../apps/prototype/src/branch-head-prototype'
);

describe('branch head PR prototype', () => {
  test('renders the real issue development graph with an actionable diverged state', () => {
    const markup = renderToStaticMarkup(
      <BranchHeadPrototype theme="dark" />
    );

    expect(markup).toContain('Development session');
    expect(markup).toContain('issue-408-show-a-focused-git-graph');
    expect(markup).toContain('Diverged — 2 ahead, 2 behind; action required');
    expect(markup).toContain('history collapsed');
    expect(markup).toContain('Open focused History');
  });
});
