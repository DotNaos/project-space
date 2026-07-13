import { afterEach, describe, expect, test } from 'bun:test';

import {
  codexSessionRoute,
  parseCodexSessionRoute,
  writeCodexSessionRoute
} from '../src/features/codex-sessions/codex-session-route';
import {
  initialProjectMainView,
  parseProjectRoute,
  routeForView
} from '../src/features/project-desktop/hooks/project-desktop-routing';

const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});

describe('Codex session stable routes', () => {
  test('routes by machine and thread identifiers without titles', () => {
    const route = codexSessionRoute({ machineId: 'machine:os-macbook', threadId });
    expect(route).toBe(`/codex/machine%3Aos-macbook/${threadId}`);
    expect(parseCodexSessionRoute(route)).toEqual({
      machineId: 'machine:os-macbook',
      matches: true,
      threadId
    });
  });

  test('supports the list and machine-only destinations', () => {
    expect(parseCodexSessionRoute(codexSessionRoute())).toEqual({ matches: true });
    expect(parseCodexSessionRoute(codexSessionRoute({ machineId: 'machine-one' }))).toEqual({
      machineId: 'machine-one',
      matches: true,
      threadId: undefined
    });
  });

  test('rejects malformed, nested, and title-shaped routes', () => {
    expect(parseCodexSessionRoute('/codex/machine-one/not-a-thread')).toEqual({ matches: false });
    expect(parseCodexSessionRoute(`/codex/machine-one/${threadId}/extra`)).toEqual({ matches: false });
    expect(parseCodexSessionRoute('/codex/os%20macbook/thread')).toEqual({ matches: false });
    expect(parseCodexSessionRoute('/projects/project-space/codex')).toEqual({ matches: false });
  });

  test('integrates list and exact session targets into desktop routing', () => {
    expect(routeForView('codex')).toBe('/codex');
    expect(initialProjectMainView('/codex')).toBe('codex');
    expect(parseProjectRoute(`/codex/machine-one/${threadId}`)).toEqual({
      codexMachineId: 'machine-one',
      codexThreadId: threadId,
      view: 'codex'
    });
  });

  test('pushes exact machine and thread identifiers while preserving URL state', () => {
    const pushed: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          pushState(_state: unknown, _unused: string, url: string) { pushed.push(url); },
          replaceState() { throw new Error('Expected a pushed navigation.'); }
        },
        location: { hash: '#activity', pathname: '/chat', search: '?source=project-chat' }
      }
    });

    writeCodexSessionRoute({ machineId: 'machine:mac', threadId });

    expect(pushed).toEqual([
      `/codex/machine%3Amac/${threadId}?source=project-chat#activity`
    ]);
  });
});
