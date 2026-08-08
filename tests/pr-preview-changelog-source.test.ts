import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readExactPullRequestChangelogSource } from '../server/pr-preview-changelog-source';

const roots: string[] = [];

function repositoryRoot(source: unknown) {
  const root = join(
    process.cwd(),
    '.tmp',
    `pr-preview-changelog-${crypto.randomUUID()}`
  );
  const changelogDirectory = join(
    root,
    'apps/docs/content/docs/changelog'
  );
  mkdirSync(changelogDirectory, { recursive: true });
  writeFileSync(
    join(changelogDirectory, 'entries.json'),
    JSON.stringify(source)
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('exact pull request changelog source', () => {
  test('returns only entries from the requested pull request', () => {
    const current = {
      body: 'Branch-only and Draft PR development stay Active.',
      category: 'fixed',
      id: 'pr-504-active-development',
      issueNumber: 501,
      prototype: {
        scenarioId: 'ready',
        surface: 'desktop-prototype',
        viewport: 'desktop'
      },
      pullRequestNumber: 504,
      summary: 'Clarify active development.',
      testing: ['Verify the branch-only state.']
    };
    const root = repositoryRoot({
      entries: [
        current,
        { id: 'unrelated-invalid-entry', pullRequestNumber: 498 }
      ],
      schema: 'project-space.changelog/v1'
    });

    expect(readExactPullRequestChangelogSource(root, 504)).toEqual({
      entries: [current],
      schema: 'project-space.changelog/v1'
    });
  });

  test('returns an empty valid source when the pull request has no entry', () => {
    const root = repositoryRoot({
      entries: [],
      schema: 'project-space.changelog/v1'
    });

    expect(readExactPullRequestChangelogSource(root, 504)).toEqual({
      entries: [],
      schema: 'project-space.changelog/v1'
    });
  });

  test('fails closed when the exact-source file is invalid or missing', () => {
    const invalidRoot = repositoryRoot({ entries: [], schema: 'wrong' });
    const invalidEntryRoot = repositoryRoot({
      entries: [{ id: 'invalid', pullRequestNumber: 504 }],
      schema: 'project-space.changelog/v1'
    });

    expect(readExactPullRequestChangelogSource(invalidRoot, 504)).toBeUndefined();
    expect(
      readExactPullRequestChangelogSource(invalidEntryRoot, 504)
    ).toBeUndefined();
    expect(
      readExactPullRequestChangelogSource(join(invalidRoot, 'missing'), 504)
    ).toBeUndefined();
  });
});
