import { describe, expect, test } from 'bun:test';

import {
  dismissReleaseChangelogCard,
  releaseChangelogDismissalKey,
  releaseChangelogVersionFromSearch,
  shouldShowReleaseChangelogCard,
  type ReleaseChangelogStorage
} from '../src/features/release-changelog/release-changelog-state';

function memoryStorage(): ReleaseChangelogStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

describe('release changelog visibility', () => {
  test('shows deterministically on every visit until that exact version is dismissed', () => {
    const storage = memoryStorage();

    expect(shouldShowReleaseChangelogCard('0.9.1', storage)).toBe(true);
    expect(shouldShowReleaseChangelogCard('0.9.1', storage)).toBe(true);

    dismissReleaseChangelogCard('0.9.1', storage);

    expect(shouldShowReleaseChangelogCard('0.9.1', storage)).toBe(false);
    expect(shouldShowReleaseChangelogCard('0.9.2', storage)).toBe(true);
  });

  test('fails open if persistent storage is blocked', () => {
    const blocked: ReleaseChangelogStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      }
    };

    expect(shouldShowReleaseChangelogCard('0.9.1', blocked)).toBe(true);
    expect(() => dismissReleaseChangelogCard('0.9.1', blocked)).not.toThrow();
  });

  test('normalizes version keys and deep links', () => {
    expect(releaseChangelogDismissalKey('v0.9.1')).toBe(
      'project-space:release-changelog:dismissed:0.9.1'
    );
    expect(releaseChangelogVersionFromSearch('?release=v0.9.0')).toBe('0.9.0');
    expect(releaseChangelogVersionFromSearch('?release=next')).toBeUndefined();
  });
});
