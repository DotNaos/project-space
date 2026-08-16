import { describe, expect, test } from 'bun:test';
import {
  buildCodexChatThreadSections,
  codexChatThreadId,
  newestSessionForWorktree,
  parseCodexChatThreadId
} from '../src/features/codex-sessions/project-codex-chat-model';
import type { CodexHostInventoryItem } from '../src/shared/codex-host-inventory-api';
import type { CodexSession } from '../src/features/codex-sessions/codex-sessions-types';
import { codexAgentIdentity } from '../src/features/codex-sessions/codex-agent-identity';

const host: CodexHostInventoryItem = {
  addresses: ['100.80.135.9'],
  machineId: 'machine-online',
  name: 'os-macbook',
  tailscaleDeviceId: 'device-online',
  worktrees: [{ label: 'project-space', path: '/project-space', threadCount: 6 }]
};

function session(index: number, machineId = host.machineId): CodexSession {
  return {
    cwd: '/project-space',
    lastActivityAt: `2026-08-16T1${index}:00:00.000Z`,
    loadedByProjectSpace: true,
    machineId,
    status: index === 5 ? 'active' : 'idle',
    stored: true,
    threadId: `thread-${index}`,
    title: `Task ${index}`
  };
}

describe('Project Codex chat model', () => {
  test('groups only online hosts and asks the sidebar to collapse after four tasks', () => {
    const sections = buildCodexChatThreadSections(
      [host],
      [...Array.from({ length: 6 }, (_, index) => session(index)), session(9, 'offline-machine')],
      { machineId: host.machineId, threadId: 'thread-5' }
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ collapsedCount: 4, heading: 'os-macbook', meta: '6 tasks' });
    expect(sections[0]?.threads).toHaveLength(6);
    expect(sections[0]?.threads[0]).toMatchObject({ active: true, label: 'Task 5', tone: 'success' });
    expect(sections[0]?.threads.some((thread) => thread.label === 'Task 9')).toBe(false);
  });

  test('opens the latest real task for a selected worktree', () => {
    expect(newestSessionForWorktree([session(2), session(5)], host.machineId, '/project-space')?.threadId)
      .toBe('thread-5');
  });

  test('round-trips a thread selection without delimiter ambiguity', () => {
    const origin = { machineId: 'machine:one', threadId: 'thread/one' };
    expect(parseCodexChatThreadId(codexChatThreadId(origin))).toEqual(origin);
    expect(parseCodexChatThreadId('invalid')).toBeUndefined();
  });

  test('derives the claimed agent identity used for task avatars', () => {
    expect(codexAgentIdentity('#479 · Hera · Redesign Project Chat')).toEqual({
      category: 'mythology',
      name: 'Hera'
    });
    expect(codexAgentIdentity('#479/2 · Picasso · Review chat')).toEqual({
      category: 'artist',
      name: 'Picasso'
    });
  });
});
