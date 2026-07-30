import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({
    children,
    isIconOnly: _isIconOnly,
    onPress: _onPress,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    isIconOnly?: boolean;
    onPress?(): void;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', props, children),
  Chip: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('span', props, children),
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

const { BranchHeadGraphPreview } = await import(
  '../src/features/project-desktop/components/branch-head-graph-preview'
);

const defaultSha = 'b'.repeat(40);
const headSha = 'a'.repeat(40);
const mergeBaseSha = 'c'.repeat(40);

describe('branch head graph preview', () => {
  test('keeps action-required status visible beside a bounded graph and History action', () => {
    const html = renderToStaticMarkup(
      <BranchHeadGraphPreview
        comparison={{
          result: {
            aheadBy: 2,
            behindBy: 1,
            checkedAt: '2026-07-30T10:00:00Z',
            commits: [
              {
                author: 'Test',
                date: '2026-07-30',
                hash: headSha,
                parents: [mergeBaseSha],
                refs: ['origin/feature/issue-408'],
                subject: 'Build the graph preview'
              },
              {
                author: 'Test',
                date: '2026-07-30',
                hash: defaultSha,
                parents: [mergeBaseSha],
                refs: ['trunk', 'origin/trunk'],
                subject: 'Update the default branch'
              },
              {
                author: 'Test',
                date: '2026-07-29',
                hash: mergeBaseSha,
                parents: [],
                refs: [],
                subject: 'Common base'
              }
            ],
            defaultBranch: { name: 'trunk', sha: defaultSha },
            freshness: 'current',
            head: { name: 'feature/issue-408', sha: headSha },
            mergeBaseIncluded: true,
            mergeBaseSha,
            state: 'diverged',
            status: 'connected',
            truncated: false
          },
          state: 'ready'
        }}
        onOpenHistory={() => {}}
      />
    );

    expect(html).toContain('Diverged — 2 ahead, 1 behind; action required');
    expect(html).toContain('feature/issue-408');
    expect(html).toContain('trunk');
    expect(html).toContain('Build the graph preview');
    expect(html).toContain('Open focused History');
    expect(html).toContain('aria-expanded="true"');
  });

  test('shows a stale warning without a misleading graph action', () => {
    const html = renderToStaticMarkup(
      <BranchHeadGraphPreview
        comparison={{
          result: {
            checkedAt: '2026-07-30T10:00:00Z',
            commits: [],
            freshness: 'stale',
            mergeBaseIncluded: false,
            message: 'The linked pull request head changed.',
            reason: 'stale-head',
            status: 'connected',
            truncated: false
          },
          state: 'ready'
        }}
        onOpenHistory={() => {}}
      />
    );

    expect(html).toContain('The linked pull request head changed.');
    expect(html).not.toContain('Open focused History');
  });
});
