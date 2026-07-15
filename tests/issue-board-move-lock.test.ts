import { describe, expect, test } from 'bun:test';

import { IssueBoardMoveLock } from '../src/features/project-desktop/components/issue-board-move-lock';

describe('issue board move lock', () => {
  test('serializes moves for one issue while allowing other issues to move', () => {
    const lock = new IssueBoardMoveLock();

    const first = lock.begin(179, 'closed');
    expect(first).not.toBeNull();
    expect(lock.begin(179, 'ready')).toBeNull();
    expect(lock.begin(180, 'ready')).not.toBeNull();
    expect(lock.snapshot()).toEqual(new Map([
      [179, 'closed'],
      [180, 'ready']
    ]));

    expect(lock.finish({ issueNumber: 179, columnId: 'closed' })).toBe(false);
    expect(lock.finish(first!)).toBe(true);
    expect(lock.begin(179, 'ready')).not.toBeNull();
  });

  test('clears all in-flight moves when repository scope changes', () => {
    const lock = new IssueBoardMoveLock();
    const stale = lock.begin(179, 'closed');

    lock.clear();

    expect(lock.snapshot().size).toBe(0);
    expect(lock.begin(179, 'ready')).not.toBeNull();
    expect(lock.finish(stale!)).toBe(false);
    expect(lock.snapshot()).toEqual(new Map([[179, 'ready']]));
  });
});
