import { describe, expect, test } from 'bun:test';
import type { GitHistoryCommit } from '../src/shared/project-space-api';
import { mergeFocusedGitHistories } from '../src/features/project-desktop/components/git-focused-history';

function commit(
  hash: string,
  parents: string[],
  date: string
): GitHistoryCommit {
  return {
    author: 'Test Author',
    date,
    hash,
    parents,
    refs: [],
    subject: hash
  };
}

describe('focused Git history merging', () => {
  test('keeps every child before its parent across two histories', () => {
    const base = commit('base', [], '2026-07-28T10:00:00Z');
    const headParent = commit('head-parent', ['base'], '2026-07-29T10:00:00Z');
    const head = commit('head', ['head-parent'], '2026-07-30T10:00:00Z');
    const defaultHead = commit('default', ['base'], '2026-07-30T09:00:00Z');

    const result = mergeFocusedGitHistories([
      [defaultHead, base],
      [head, headParent, base]
    ]);
    const position = new Map(result.map((entry, index) => [entry.hash, index]));

    expect(result.map((entry) => entry.hash)).toEqual([
      'head',
      'default',
      'head-parent',
      'base'
    ]);
    for (const entry of result) {
      for (const parent of entry.parents) {
        expect(position.get(entry.hash)).toBeLessThan(position.get(parent) ?? Infinity);
      }
    }
  });

  test('deduplicates the common history', () => {
    const base = commit('base', [], '2026-07-28T10:00:00Z');
    const result = mergeFocusedGitHistories([[base], [base]]);

    expect(result).toEqual([base]);
  });

  test('keeps both branch refs when focused histories share one tip', () => {
    const head = {
      ...commit('shared', [], '2026-07-30T10:00:00Z'),
      refs: ['refs/heads/feature']
    };
    const defaultHead = {
      ...head,
      refs: ['refs/heads/main']
    };

    expect(mergeFocusedGitHistories([[head], [defaultHead]])).toEqual([{
      ...defaultHead,
      refs: ['refs/heads/feature', 'refs/heads/main']
    }]);
  });
});
