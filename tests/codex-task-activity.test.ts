import { describe, expect, test } from 'bun:test';

import {
  applyCodexActivityEvent,
  createCodexTaskActivity,
  inferCodexTaskIdentity,
  preferCodexTaskActivity,
  withCodexInventoryFreshness
} from '../src/shared/codex-task-activity';

function inventoryActivity(status: 'active' | 'idle' = 'idle') {
  return createCodexTaskActivity({
    archived: false,
    lastActivityAt: '2026-08-10T10:00:00.000Z',
    observedAt: '2026-08-10T10:00:01.000Z',
    status,
    turns: [{
      id: 'turn-one',
      items: [{ id: 'command-one', kind: 'command', status: status === 'active' ? 'in-progress' : 'completed' }],
      startedAt: '2026-08-10T09:59:58.000Z',
      status: status === 'active' ? 'in-progress' : 'completed'
    }]
  });
}

describe('canonical Codex task activity', () => {
  test('keeps live turn evidence authoritative over a later idle inventory observation', () => {
    const running = applyCodexActivityEvent(inventoryActivity(), {
      eventId: 'delta-one',
      observedAt: '2026-08-10T10:00:02.000Z',
      delta: 'Working',
      itemId: 'message-one',
      turnId: 'turn-two',
      type: 'agent-message-delta'
    }, 14);
    const idlePoll = {
      ...inventoryActivity(),
      lastEventAt: '2026-08-10T10:00:03.000Z',
      lastSuccessfulRefreshAt: '2026-08-10T10:00:03.000Z'
    };

    expect(preferCodexTaskActivity(running, idlePoll)).toMatchObject({
      conversationState: 'running',
      currentTurnId: 'turn-two',
      currentTurnState: 'running',
      eventSequence: 14
    });
  });

  test('accepts terminal evidence for the same active turn', () => {
    const running = applyCodexActivityEvent(inventoryActivity(), {
      eventId: 'status-one',
      observedAt: '2026-08-10T10:00:02.000Z',
      status: 'active',
      turnId: 'turn-one',
      type: 'session-status'
    }, 15);
    const completed = {
      ...inventoryActivity(),
      conversationState: 'completed' as const,
      currentTurnState: 'completed' as const,
      lastEventAt: '2026-08-10T10:00:04.000Z',
      lastSuccessfulRefreshAt: '2026-08-10T10:00:04.000Z'
    };

    expect(preferCodexTaskActivity(running, completed)).toBe(completed);
  });

  test('preserves conversation truth while marking disconnected inventory stale', () => {
    const session = withCodexInventoryFreshness({
      activity: inventoryActivity('active'),
      archived: false,
      id: 'thread-one',
      lastActivityAt: '2026-08-10T10:00:00.000Z',
      loadedByProjectSpace: true,
      machineId: 'machine-one',
      machineName: 'OS-PC',
      status: 'active',
      title: '#572 Redesign chat page'
    }, {
      checkedAt: '2026-08-10T10:01:00.000Z',
      inventoryState: 'stale',
      online: false
    });

    expect(session.activity).toMatchObject({
      conversationState: 'running',
      freshness: 'stale',
      machineState: 'offline'
    });
  });

  test('derives stable issue, repository, branch, and worktree identity', () => {
    expect(inferCodexTaskIdentity(
      '/home/oli/projects/.worktrees/project-space/issue-572-redesign-chat-page/src',
      'Redesign chat page',
      'OS-PC'
    )).toEqual({
      branch: 'issue-572-redesign-chat-page',
      issueNumber: 572,
      repository: 'project-space',
      worktree: '/home/oli/projects/.worktrees/project-space/issue-572-redesign-chat-page'
    });
  });

  test('uses the full GitHub issue URL as owner-scoped task identity', () => {
    expect(inferCodexTaskIdentity(
      '/home/oli/projects/.worktrees/project-space/issue-596-machine-aware/src',
      'Implement https://github.com/DotNaos/project-space/issues/596 with focused tests',
      'OS-PC'
    )).toEqual({
      branch: 'issue-596-machine-aware',
      issueNumber: 596,
      repository: 'DotNaos/project-space',
      worktree: '/home/oli/projects/.worktrees/project-space/issue-596-machine-aware'
    });
  });

  test('ignores repository enrichment from a conflicting issue URL', () => {
    expect(inferCodexTaskIdentity(
      '/home/oli/projects/.worktrees/project-space/issue-596-machine-aware/src',
      'Review https://github.com/Other/project-space/issues/597',
      'OS-PC'
    )).toEqual({
      branch: 'issue-596-machine-aware',
      issueNumber: 596,
      repository: 'project-space',
      worktree: '/home/oli/projects/.worktrees/project-space/issue-596-machine-aware'
    });
  });
});
