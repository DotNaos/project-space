import { describe, expect, mock, test } from 'bun:test';

import * as changelogApi from '../src/shared/pr-preview-changelog-api';

mock.module('@/shared/pr-preview-changelog-api', () => changelogApi);

const {
  dismissPreviewChangelog,
  previewChangelogDismissalKey,
  shouldOpenPreviewChangelog
} = await import(
  '../src/features/pr-preview-changelog/pull-request-changelog-dialog-state'
);

interface PreviewChangelogDismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const identity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 298,
  repositoryFullName: 'DotNaos/project-space'
};

function memoryStorage(): PreviewChangelogDismissalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

describe('Preview changelog dialog state', () => {
  test('opens once for an exact pull request revision', () => {
    const storage = memoryStorage();

    expect(shouldOpenPreviewChangelog(identity, storage)).toBe(true);
    dismissPreviewChangelog(identity, storage);
    expect(shouldOpenPreviewChangelog(identity, storage)).toBe(false);
  });

  test('opens again for a newly deployed head', () => {
    const storage = memoryStorage();
    dismissPreviewChangelog(identity, storage);

    expect(
      shouldOpenPreviewChangelog(
        { ...identity, headSha: 'b'.repeat(40) },
        storage
      )
    ).toBe(true);
  });

  test('keys dismissal by repository, pull request, and full head', () => {
    expect(previewChangelogDismissalKey(identity)).toContain(
      `dotnaos/project-space:298:${'a'.repeat(40)}`
    );
    expect(
      previewChangelogDismissalKey({ ...identity, headSha: 'short' })
    ).toBeUndefined();
  });

  test('keeps the dialog usable when browser storage is unavailable', () => {
    const unavailableStorage: PreviewChangelogDismissalStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      }
    };

    expect(
      shouldOpenPreviewChangelog(identity, unavailableStorage)
    ).toBe(true);
    expect(() =>
      dismissPreviewChangelog(identity, unavailableStorage)
    ).not.toThrow();
  });
});
