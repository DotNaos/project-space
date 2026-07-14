import { describe, expect, test } from 'bun:test';

import { moveIssueToColumn } from '../src/features/project-desktop/components/issue-board-move';
import type { GitHubIssueRecord } from '../src/shared/project-space-api';

function issue(state: GitHubIssueRecord['state'] = 'open'): GitHubIssueRecord {
  return {
    labels: [],
    number: 179,
    state,
    title: 'Responsive issues',
    url: 'https://github.com/DotNaos/project-space/issues/179'
  };
}

describe('authoritative issue board moves', () => {
  test('keeps open-column placement local without calling GitHub', async () => {
    let calls = 0;
    const result = await moveIssueToColumn({
      columnId: 'in-progress',
      isCurrentRepository: () => true,
      issue: issue(),
      repositoryFullName: 'DotNaos/project-space',
      async updateIssue() {
        calls += 1;
        return { checkedAt: '', status: 'error' };
      }
    });

    expect(result).toEqual({ state: 'ready' });
    expect(calls).toBe(0);
  });

  test('persists close and reopen only after GitHub confirms them', async () => {
    for (const [current, columnId, expected] of [
      ['open', 'closed', 'closed'],
      ['closed', 'ready', 'open']
    ] as const) {
      const result = await moveIssueToColumn({
        columnId,
        isCurrentRepository: () => true,
        issue: issue(current),
        repositoryFullName: 'DotNaos/project-space',
        async updateIssue(request) {
          expect(request.state).toBe(expected);
          return { checkedAt: '', issue: issue(expected), status: 'connected' };
        }
      });
      expect(result).toMatchObject({ issue: { state: expected }, state: 'ready' });
    }
  });

  test('blocks rejected, failed, and stale repository responses', async () => {
    const rejected = await moveIssueToColumn({
      columnId: 'closed',
      isCurrentRepository: () => true,
      issue: issue(),
      repositoryFullName: 'DotNaos/project-space',
      async updateIssue() {
        return { checkedAt: '', message: 'GitHub rejected the update.', status: 'error' };
      }
    });
    expect(rejected).toEqual({ message: 'GitHub rejected the update.', state: 'blocked' });

    const failed = await moveIssueToColumn({
      columnId: 'closed',
      isCurrentRepository: () => true,
      issue: issue(),
      repositoryFullName: 'DotNaos/project-space',
      async updateIssue() {
        throw new Error('Network unavailable.');
      }
    });
    expect(failed).toEqual({ message: 'Network unavailable.', state: 'blocked' });

    const stale = await moveIssueToColumn({
      columnId: 'closed',
      isCurrentRepository: () => false,
      issue: issue(),
      repositoryFullName: 'DotNaos/project-space',
      async updateIssue() {
        return { checkedAt: '', issue: issue('closed'), status: 'connected' };
      }
    });
    expect(stale).toMatchObject({ state: 'blocked' });
  });
});
