import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/app/dotnaos-ui', () => ({
  Text: ({ as, children, ...props }: { as?: string; children?: ReactNode; [key: string]: unknown }) => (
    createElement(as ?? 'span', props, children)
  )
}));
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

const { RoadmapIssueCard } = await import('../src/features/roadmap/roadmap-graph-node');

test('renders canonical identity, accessible selection, status, plan order, and terminal truth', () => {
  const html = renderToStaticMarkup(
    <RoadmapIssueCard
      node={{
        dimensions: { height: 148, width: 236 },
        id: 'roadmap:issue:274',
        incoming: [],
        isRoot: true,
        isTerminal: true,
        issue: {
          availability: 'ready',
          issue: { fullName: 'DotNaos/project-space', id: 274, number: 274 },
          labels: [],
          state: 'open',
          title: 'A long actionable roadmap title that remains readable across multiple lines'
        },
        outgoing: [],
        planItem: {
          issue: { fullName: 'DotNaos/project-space', id: 274, number: 274 },
          plannedState: 'planned'
        },
        planPosition: 2,
        position: { x: 0, y: 0 },
        rank: 0
      }}
      selected
    />
  );
  expect(html).toContain('aria-current="step"');
  expect(html).toContain('aria-label="Inspect issue #274:');
  expect(html).toContain('DotNaos/project-space#274');
  expect(html).toContain('Plan 02');
  expect(html).toContain('Root');
  expect(html).toContain('Ends here');
  expect(html).toContain('A long actionable roadmap title');
});
