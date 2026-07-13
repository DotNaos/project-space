import { describe, expect, test } from 'bun:test';

import {
  codexSessionRoute,
  parseCodexSessionRoute
} from '../src/features/codex-sessions/codex-session-route';

const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

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
});
