import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CodexConversationItem } from '../src/features/codex-sessions/codex-sessions-types';

mock.module('@/app/dotnaos-ui', () => ({
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

mock.module('@/features/codex-sessions/codex-markdown-message', () => ({
  CodexMarkdownMessage: ({ text }: { text: string }) => createElement('p', null, text)
}));

const { PrototypeReviewCodexHistory } = await import(
  '../src/features/pr-preview-review/prototype-review-codex-history'
);

describe('prototype review Codex history', () => {
  test('collapses consecutive activity and puts a text-only visor on the newest step', () => {
    const items: CodexConversationItem[] = [
      {
        activityKind: 'mcp-tool',
        id: 'tool-1',
        kind: 'activity',
        label: 'Loaded tools',
        state: 'completed'
      },
      {
        activityKind: 'mcp-tool',
        id: 'tool-2',
        kind: 'activity',
        label: 'Checked the browser',
        state: 'completed'
      },
      {
        activityKind: 'command',
        id: 'command-1',
        kind: 'activity',
        label: 'Ran tests',
        state: 'completed'
      },
      {
        activityKind: 'mcp-tool',
        id: 'tool-running',
        kind: 'activity',
        label: 'Inspecting the review',
        state: 'completed'
      },
      {
        id: 'assistant-streaming',
        kind: 'message',
        role: 'assistant',
        streaming: true,
        text: 'Continuing without a separate status label.'
      }
    ];

    const html = renderToStaticMarkup(
      <PrototypeReviewCodexHistory
        isDark
        items={items}
        loading={false}
        working
      />
    );

    expect(html).toContain('data-prototype-codex-activity-group="true"');
    expect(html).not.toContain('Worked with 3 tools, 1 command');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Inspecting the review');
    expect(html).toContain('prototype-codex-visor-text');
    expect(html).not.toContain('Loaded tools');
    expect(html).not.toContain('Ran tests');
    expect(html).not.toContain('Responding');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('border-l');
  });

  test('stops the visor when the task is no longer working', () => {
    const html = renderToStaticMarkup(
      <PrototypeReviewCodexHistory
        isDark
        items={[{
          activityKind: 'command',
          id: 'command-finished',
          kind: 'activity',
          label: 'Ran checks',
          state: 'completed'
        }]}
        loading={false}
        working={false}
      />
    );

    expect(html).toContain('Worked with 1 command');
    expect(html).not.toContain('Ran checks');
    expect(html).not.toContain('prototype-codex-visor-text');
  });
});
