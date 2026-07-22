import { describe, expect, mock, test } from 'bun:test';
import { createElement, createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { RoadmapResult } from '../src/shared/roadmap-api';

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, onPress, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => <button {...props} disabled={isDisabled} onClick={onPress}>{children}</button>,
  Text: ({ as, children, ...props }: {
    as?: string;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as ?? 'span', props, children)
}));
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

const SearchField = Object.assign(
  ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  {
    ClearButton: () => <button type="button">Clear</button>,
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Input: (props: Record<string, unknown>) => <input {...props} />,
    SearchIcon: () => <span>Search</span>
  }
);
mock.module('@heroui/react', () => ({
  Label: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <label {...props}>{children}</label>
  ),
  SearchField
}));

const { RoadmapWorkShelf } = await import('../src/features/roadmap/roadmap-work-shelf');

const result: RoadmapResult = {
  canEdit: true,
  checkedAt: '2026-07-22T00:00:00.000Z',
  dependencies: [],
  dependencySync: 'current',
  graphRevision: 'graph',
  issues: [],
  plan: {
    goals: [],
    items: [{
      issue: { fullName: 'DotNaos/project-space', id: 273, number: 273 },
      plannedState: 'planned'
    }],
    revision: 1
  },
  repository: { fullName: 'DotNaos/project-space', id: 42 },
  status: 'connected'
};

function renderShelf(overrides: Partial<Parameters<typeof RoadmapWorkShelf>[0]> = {}) {
  return renderToStaticMarkup(<RoadmapWorkShelf
    canEdit
    error=""
    graphRef={createRef<HTMLDivElement>()}
    isLoading={false}
    isSaving={false}
    issues={[
      { labels: ['roadmap'], number: 279, state: 'open', title: 'Add draggable issue work stack', url: 'https://example.test/279' },
      { labels: [], number: 211, state: 'closed', title: 'Durable roadmap model', url: 'https://example.test/211' }
    ]}
    onAdd={async () => true}
    onDragFeedback={() => undefined}
    onRetry={() => undefined}
    result={result}
    {...overrides}
  />);
}

describe('roadmap work shelf', () => {
  test('renders the swipe shelf with accessible add alternatives and completed work', () => {
    const html = renderShelf();
    expect(html).toContain('Unplanned work');
    expect(html).toContain('Issue #279: Add draggable issue work stack');
    expect(html).toContain('Add issue #279 as Plan 02');
    expect(html).toContain('Choose plan position for issue #279');
    expect(html).toContain('Beginning');
    expect(html).toContain('End');
    expect(html).toContain('Open');
    expect(html).toContain('Closed');
  });

  test('renders explicit loading, error, and all-planned states', () => {
    expect(renderShelf({ isLoading: true })).toContain('Loading unplanned work');
    expect(renderShelf({ error: 'GitHub is unavailable.' })).toContain('GitHub is unavailable.');
    expect(renderShelf({ issues: [] })).toContain('Every loaded issue is already in the roadmap.');
  });
});
