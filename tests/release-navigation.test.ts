import { describe, expect, test } from 'bun:test';
import { buildReleaseFolder } from '../apps/docs/lib/releases/navigation';
import {
  activeAnchorAtReadingLine,
  canShowPreviewOnly,
} from '../apps/docs/lib/releases/presentation';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import { releaseEntryFixture } from './release-entry-schema.test';
import {
  resolveDocsDeploymentIdentity,
} from '../apps/docs/lib/deployment-identity';

function entry(version: string, pullRequest: number) {
  const result = parseReleaseEntryMdx(
    releaseEntryFixture({ pullRequest, version }),
    `${pullRequest}.mdx`,
  );
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.entry;
}

describe('release documentation navigation', () => {
  test('builds newest-first Major → Minor → Patch folders', () => {
    const folder = buildReleaseFolder([
      entry('0.3.9', 399),
      entry('1.0.0', 405),
      entry('0.4.43', 402),
      entry('0.4.44', 403),
    ]);

    const history = folder.children.filter(
      (node) => node.type === 'folder',
    );
    expect(history.map((node) => String(node.name))).toEqual([
      'v1',
      'v0',
    ]);
    const v0 = history[1];
    if (v0.type !== 'folder') throw new Error('expected v0');
    expect(
      v0.children.map((node) => String(node.name)),
    ).toEqual(['v0.4', 'v0.3']);
    const v04 = v0.children[0];
    if (v04.type !== 'folder') throw new Error('expected v0.4');
    expect(v04.children.map((node) => String(node.name))).toEqual([
      'v0.4.44 · Latest',
      'v0.4.43',
    ]);
    expect(v04.children.map((node) => node.type === 'page' && node.url))
      .toEqual([
        '/docs/releases/v0.4#v0-4-44',
        '/docs/releases/v0.4#v0-4-43',
      ]);
  });

  test('opens only the current major and minor by default', () => {
    const folder = buildReleaseFolder([
      entry('1.0.0', 405),
      entry('0.4.44', 403),
      entry('0.3.9', 399),
    ]);
    const majors = folder.children.filter(
      (node) => node.type === 'folder',
    );

    expect(majors.map((node) => node.defaultOpen)).toEqual([
      true,
      false,
    ]);
    const latestMajor = majors[0];
    if (latestMajor.type !== 'folder') throw new Error('expected folder');
    expect(
      latestMajor.children.map(
        (node) => node.type === 'folder' && node.defaultOpen,
      ),
    ).toEqual([true]);
  });

  test('uses honest Preview labels without changing the hierarchy', () => {
    const folder = buildReleaseFolder(
      [entry('0.4.44', 403)],
      { previewPullRequest: 403 },
    );
    const pages = folder.children.filter(
      (node) => node.type === 'page',
    );
    expect(String(pages[0]?.name)).toBe('Preview · v0.4.44');
    const major = folder.children.find(
      (node) => node.type === 'folder',
    );
    if (major?.type !== 'folder') throw new Error('expected major');
    const minor = major.children[0];
    if (minor.type !== 'folder') throw new Error('expected minor');
    expect(String(minor.children[0]?.name)).toBe(
      'v0.4.44 · Preview',
    );
  });

  test('follows the last patch above the reading line', () => {
    expect(
      activeAnchorAtReadingLine(
        [
          { id: 'v0-4-44', top: -600 },
          { id: 'v0-4-43', top: 80 },
          { id: 'v0-4-42', top: 760 },
        ],
        180,
      ),
    ).toBe('v0-4-43');
  });

  test('shows Preview-only guidance only for exact verified PR identity', () => {
    const release = entry('0.4.44', 403);
    const commit = 'a'.repeat(40);
    const exact = resolveDocsDeploymentIdentity(
      {
        commit,
        preview: {
          identity: {
            headSha: commit,
            pullRequestNumber: 403,
            repositoryFullName: 'DotNaos/project-space',
          },
          state: 'verified',
        },
        version: '0.4.44',
      },
      'pr-403.projects.os-home.net',
    );
    const wrongHead = resolveDocsDeploymentIdentity(
      {
        commit,
        preview: {
          identity: {
            headSha: 'b'.repeat(40),
            pullRequestNumber: 403,
            repositoryFullName: 'DotNaos/project-space',
          },
          state: 'verified',
        },
        version: '0.4.44',
      },
      'pr-403.projects.os-home.net',
    );

    expect(canShowPreviewOnly(release, exact)).toBe(true);
    expect(canShowPreviewOnly(release, wrongHead)).toBe(false);
    expect(
      canShowPreviewOnly(release, {
        ...exact,
        pullRequestNumber: 404,
      }),
    ).toBe(false);
  });
});
