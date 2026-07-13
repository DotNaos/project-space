import { describe, expect, test } from 'bun:test';
import {
  codexContinueBlockReason,
  codexThreadOrigin,
  effectiveCodexSessionStatus,
  formatCodexActivity,
  groupCodexSessions,
  sortCodexSessions
} from '../src/features/codex-sessions/codex-sessions-model';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';

const machines: CodexMachine[] = [
  { id: 'machine-mac', name: 'os-macbook', status: 'connected' },
  { id: 'machine-pc', name: 'os-pc', status: 'offline' }
];

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    cwd: '/Users/oli/projects/project-space',
    lastActivityAt: '2026-07-13T08:00:00.000Z',
    loadedByProjectSpace: false,
    machineId: 'machine-mac',
    model: 'gpt-5',
    projectName: 'project-space',
    status: 'idle',
    stored: true,
    threadId: 'thread-149',
    title: '#149 · Integrate Codex sessions',
    ...overrides
  };
}

describe('Codex session list model', () => {
  test('orders sessions by newest activity without mutating input', () => {
    const input = [
      session({ lastActivityAt: '2026-07-13T07:00:00.000Z', threadId: 'older', title: 'Older' }),
      session({ lastActivityAt: '2026-07-13T09:00:00.000Z', threadId: 'newer', title: 'Newer' })
    ];

    expect(sortCodexSessions(input).map((entry) => entry.threadId)).toEqual(['newer', 'older']);
    expect(input.map((entry) => entry.threadId)).toEqual(['older', 'newer']);
  });

  test('groups process-loaded sessions separately from stored sessions', () => {
    const groups = groupCodexSessions(machines, [
      session({ loadedByProjectSpace: true, threadId: 'loaded' }),
      session({ loadedByProjectSpace: false, threadId: 'stored' })
    ]);

    expect(groups[0].sections.map((section) => ({
      ids: section.sessions.map((entry) => entry.threadId),
      label: section.label
    }))).toEqual([
      { ids: ['loaded'], label: 'Loaded by Project Space' },
      { ids: ['stored'], label: 'Stored sessions' }
    ]);
  });

  test('keeps connected machines with no sessions visible in the unfiltered list', () => {
    const groups = groupCodexSessions(machines, [session()]);
    expect(groups.map((group) => [group.machine.id, group.sections.length])).toEqual([
      ['machine-mac', 1],
      ['machine-pc', 0]
    ]);
  });

  test('searches title, directory, model, and owning machine', () => {
    const remote = session({
      cwd: 'C:\\work\\remote-tooling',
      machineId: 'machine-pc',
      model: 'gpt-5-mini',
      projectName: 'remote-tooling',
      threadId: 'remote-thread',
      title: 'Connector recovery'
    });
    const sessions = [session(), remote];

    expect(groupCodexSessions(machines, sessions, 'remote-tooling')[0].machine.id).toBe('machine-pc');
    expect(groupCodexSessions(machines, sessions, 'gpt-5-mini')[0].machine.id).toBe('machine-pc');
    expect(groupCodexSessions(machines, sessions, 'os-pc')[0].sections[0].sessions[0].threadId).toBe('remote-thread');
  });

  test('uses machine connectivity as the honest effective status', () => {
    const remote = session({ machineId: 'machine-pc', status: 'active' });
    expect(effectiveCodexSessionStatus(remote, machines[1])).toBe('offline');
    expect(effectiveCodexSessionStatus(session(), machines[0])).toBe('idle');
  });
});

describe('Codex session continuation safety', () => {
  test('allows continuation only when the thread and owning machine are idle', () => {
    expect(codexContinueBlockReason(session(), machines[0])).toBeUndefined();
    expect(codexContinueBlockReason(session({ status: 'active' }), machines[0])).toBe(
      'Running — new turns wait until this thread is idle.'
    );
    expect(codexContinueBlockReason(session({ machineId: 'machine-pc' }), machines[1])).toBe(
      'The owning machine is offline.'
    );
  });

  test('keeps machine and thread identifiers together for every routed action', () => {
    expect(codexThreadOrigin(session())).toEqual({
      machineId: 'machine-mac',
      threadId: 'thread-149'
    });
  });

  test('formats recent activity against an explicit clock', () => {
    const now = new Date('2026-07-13T09:00:00.000Z');
    expect(formatCodexActivity('2026-07-13T08:59:30.000Z', now)).toBe('Now');
    expect(formatCodexActivity('2026-07-13T08:45:00.000Z', now)).toBe('15m ago');
    expect(formatCodexActivity('2026-07-13T06:00:00.000Z', now)).toBe('3h ago');
  });
});

