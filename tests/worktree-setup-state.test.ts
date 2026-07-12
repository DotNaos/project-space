import { describe, expect, test } from 'bun:test';

import {
  addSetupOperation,
  hasPendingWorktreeSetup,
  removeSetupOperation,
  setupOperationKey
} from '../src/features/project-desktop/hooks/worktree-setup-state';

describe('worktree setup pending state', () => {
  test('tracks independent worktrees while setup runs concurrently', () => {
    const first = setupOperationKey('worktree-a', 'install');
    const second = setupOperationKey('worktree-b', 'install');
    let pending = addSetupOperation(new Set(), first);
    pending = addSetupOperation(pending, second);

    expect(hasPendingWorktreeSetup(pending, 'worktree-a')).toBe(true);
    expect(hasPendingWorktreeSetup(pending, 'worktree-b')).toBe(true);

    pending = removeSetupOperation(pending, second);
    expect(hasPendingWorktreeSetup(pending, 'worktree-a')).toBe(true);
    expect(hasPendingWorktreeSetup(pending, 'worktree-b')).toBe(false);
  });
});
