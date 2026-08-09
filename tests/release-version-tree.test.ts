import { describe, expect, test } from 'bun:test';

import { buildReleaseVersionTree } from '../src/features/release-changelog/release-version-tree';
import type { ReleaseChangelogEntry } from '../src/shared/release-changelog-api';

function release(version: string): ReleaseChangelogEntry {
  return {
    body: '',
    name: `Release ${version}`,
    publishedAt: '2026-08-01T12:00:00.000Z',
    tag: `v${version}`,
    url: `https://github.com/DotNaos/project-space/releases/tag/v${version}`,
    version
  };
}

describe('release version tree', () => {
  test('builds newest-first major and minor folders with patch leaves', () => {
    const tree = buildReleaseVersionTree([
      release('0.8.3'),
      release('1.0.0'),
      release('0.9.0'),
      release('0.9.2'),
      release('0.9.1')
    ]);

    expect(tree.map((major) => major.label)).toEqual(['v1', 'v0']);
    expect(tree[1]?.minors.map((minor) => minor.label)).toEqual(['v0.9', 'v0.8']);
    expect(tree[1]?.minors[0]?.releases.map((entry) => entry.version)).toEqual([
      '0.9.2',
      '0.9.1',
      '0.9.0'
    ]);
  });
});
