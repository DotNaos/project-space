import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled }, children),
  Chip: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('span', props, children),
  Tab: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children),
  TabIndicator: () => null,
  TabList: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
  Tabs: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
  Text: ({ as = 'span', children, ...props }: { as?: ElementType; children?: ReactNode; [key: string]: unknown }) => createElement(as, props, children)
}));

mock.module('@heroui/react', () => ({
  Button: ({ children, isDisabled, isIconOnly: _isIconOnly, size: _size, variant: _variant, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled }, children),
  Spinner: (props: Record<string, unknown>) => createElement('span', { ...props, 'data-spinner': true })
}));

const {
  browserMirrorHasActivity,
  CodexBrowserPane,
  mergeCodexBrowserResult
} = await import('../src/features/codex-sessions/codex-browser-pane');
const { CodexDecisionPanel } = await import('../src/features/codex-sessions/codex-decision-panel');
const {
  clampCodexChatSplitPercent,
  shouldAutoOpenCodexBrowser
} = await import('../src/features/codex-sessions/codex-task-workspace-model');

const identity = {
  checkedAt: '2026-07-15T10:00:00.000Z',
  machineId: 'machine-a',
  threadId: '019f65f6-4ae8-7951-b007-47d403ab5fd6',
  turnId: 'turn-a'
};

describe('Codex browser task workspace', () => {
  test('shows a read-only live frame without exposing a runtime identifier', () => {
    const html = renderToStaticMarkup(
      <CodexBrowserPane
        state={{
          kind: 'result',
          result: {
            ...identity,
            imageDataUrl: 'data:image/webp;base64,UklGRg==',
            pageUrl: 'https://example.com/',
            state: 'live'
          }
        }}
        taskTitle="Verify project flow"
      />
    );
    expect(html).toContain('Browser live');
    expect(html).toContain('Read-only');
    expect(html).toContain('data-browser-input="blocked"');
    expect(html).toContain('https://example.com/');
    expect(html).not.toContain('browserId');
    expect(html).not.toContain('sessionId');
  });

  test('presents an ended frame as clearly non-live read-only content', () => {
    const html = renderToStaticMarkup(
      <CodexBrowserPane
        state={{
          kind: 'result',
          result: {
            ...identity,
            imageDataUrl: 'data:image/webp;base64,UklGRg==',
            state: 'ended'
          }
        }}
        taskTitle="Verify project flow"
      />
    );
    expect(html).toContain('Browser session ended');
    expect(html).toContain('final read-only frame');
    expect(html).toContain('ended browser final frame');
    expect(html).toContain('<img');
  });

  test.each([
    ['checking', { kind: 'checking' as const }, 'checking'],
    ['offline', { kind: 'offline' as const, reason: 'Connector offline' }, 'The owning connector is offline'],
    ['disconnected', { kind: 'disconnected' as const, reason: 'Connection lost' }, 'Browser mirror disconnected'],
    ['unauthorized', { kind: 'unauthorized' as const, reason: 'Access denied' }, 'Browser access is not authorized'],
    ['reconnecting', {
      kind: 'reconnecting' as const,
      previous: {
        ...identity,
        imageDataUrl: 'data:image/webp;base64,UklGRg==',
        state: 'live' as const
      },
      reason: 'Retrying'
    }, 'Reconnecting to the live mirror'],
    ['loading', { kind: 'result' as const, result: { ...identity, state: 'loading' as const } }, 'Opening the live browser mirror'],
    ['unavailable', {
      kind: 'result' as const,
      result: { ...identity, reason: 'Snapshot expired', state: 'unavailable' as const }
    }, 'Browser no longer available']
  ])('renders the %s lifecycle state', (_name, state, expected) => {
    const html = renderToStaticMarkup(
      <CodexBrowserPane state={state} taskTitle="Lifecycle test" />
    );
    expect(html).toContain(expected);
  });

  test('auto-opens only for actual browser activity in the current active turn', () => {
    expect(shouldAutoOpenCodexBrowser({
      activeTurnId: 'turn-a',
      browserState: 'live',
      browserTurnId: 'turn-a',
      openedTurns: new Set()
    })).toBe(true);
    expect(shouldAutoOpenCodexBrowser({
      activeTurnId: 'turn-a',
      browserState: 'live',
      browserTurnId: 'turn-a',
      manualCollapsedTurn: 'turn-a',
      openedTurns: new Set()
    })).toBe(false);
    expect(shouldAutoOpenCodexBrowser({
      activeTurnId: 'turn-b',
      browserState: 'loading',
      browserTurnId: 'turn-b',
      manualCollapsedTurn: 'turn-a',
      openedTurns: new Set(['turn-a'])
    })).toBe(true);
    expect(shouldAutoOpenCodexBrowser({
      activeTurnId: 'turn-b',
      browserState: 'live',
      browserTurnId: 'turn-a',
      openedTurns: new Set()
    })).toBe(false);
    expect(shouldAutoOpenCodexBrowser({
      activeTurnId: 'turn-a',
      browserState: 'ended',
      browserTurnId: 'turn-a',
      openedTurns: new Set()
    })).toBe(false);
  });

  test('uses a bounded resizable desktop split and only reveals browser UI after activity', () => {
    expect(clampCodexChatSplitPercent(55)).toBe(55);
    expect(clampCodexChatSplitPercent(10)).toBe(38);
    expect(clampCodexChatSplitPercent(90)).toBe(72);
    expect(browserMirrorHasActivity({
      kind: 'result',
      result: { ...identity, state: 'never-used' }
    })).toBe(false);
    expect(browserMirrorHasActivity({
      kind: 'result',
      result: { ...identity, state: 'loading' }
    })).toBe(true);
    expect(browserMirrorHasActivity({
      kind: 'result',
      result: { ...identity, state: 'ended' }
    })).toBe(true);
    expect(browserMirrorHasActivity({
      kind: 'reconnecting',
      previous: { ...identity, state: 'never-used' },
      reason: 'Retrying'
    })).toBe(false);
    expect(browserMirrorHasActivity({
      kind: 'reconnecting',
      previous: { ...identity, state: 'live', imageDataUrl: 'data:image/webp;base64,UklGRg==' },
      reason: 'Retrying'
    })).toBe(true);
  });

  test('reuses the previous image when a browser poll reports an unchanged frame', () => {
    const previous = {
      ...identity,
      imageDataUrl: 'data:image/webp;base64,UklGRg==',
      imageRevision: 'a'.repeat(64),
      state: 'live' as const
    };

    expect(mergeCodexBrowserResult({
      ...identity,
      imageRevision: 'a'.repeat(64),
      imageUnchanged: true,
      state: 'live'
    }, previous)).toMatchObject({
      imageDataUrl: previous.imageDataUrl,
      imageRevision: previous.imageRevision,
      state: 'live'
    });
    expect(mergeCodexBrowserResult({
      ...identity,
      imageRevision: 'b'.repeat(64),
      imageUnchanged: true,
      state: 'live'
    }, previous)).not.toHaveProperty('imageDataUrl');
  });

  test('keeps choice descriptions visible while submitting the stable choice value', () => {
    const html = renderToStaticMarkup(
      <CodexDecisionPanel
        conversation={{
          items: [],
          machineId: identity.machineId,
          threadId: identity.threadId,
          userInputRequests: [{
            id: 'input-1',
            questions: [{
              choices: [{ description: 'Use the reviewed defaults', value: 'safe' }],
              id: 'mode',
              prompt: 'Which mode should Codex use?'
            }],
            title: 'Choose a mode'
          }]
        }}
        onResolveUserInput={() => {}}
        session={{
          lastActivityAt: identity.checkedAt,
          loadedByProjectSpace: true,
          machineId: identity.machineId,
          status: 'active',
          stored: true,
          threadId: identity.threadId,
          title: 'Workspace test'
        }}
      />
    );

    expect(html).toContain('Choose a mode');
    expect(html).toContain('safe');
    expect(html).toContain('Use the reviewed defaults');
    expect(html).toContain('value="safe"');
  });
});
