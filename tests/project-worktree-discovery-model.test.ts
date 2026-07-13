import { describe, expect, test } from 'bun:test';

import { projectWorktreeDiscoverySummary } from '../src/features/project-desktop/components/project-worktree-discovery-model';

describe('worktree discovery presentation', () => {
  test('does not claim zero while checking or blocked', () => {
    expect(projectWorktreeDiscoverySummary({ state: 'checking' }, 0)).toBe('Checking worktrees');
    expect(
      projectWorktreeDiscoverySummary(
        {
          checkedAt: '2026-07-13T00:00:00.000Z',
          message: 'Connector update required.',
          reason: 'connector-update-required',
          state: 'blocked'
        },
        0
      )
    ).toBe('Discovery blocked');
  });

  test('shows zero only for proven empty evidence', () => {
    expect(
      projectWorktreeDiscoverySummary(
        {
          evidence: {
            checkedAt: '2026-07-13T00:00:00.000Z',
            projectPath: '/projects/example',
            source: 'git-worktree-list'
          },
          state: 'proven-empty',
          worktrees: []
        },
        0
      )
    ).toBe('0 worktrees · 0 servers');
  });
});
