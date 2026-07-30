import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  previewTestsForCurrentBuild,
  projectSpacePackageVersion,
} from '../apps/docs/lib/releases/preview-server';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';

const head = '9'.repeat(40);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('release Preview server identity', () => {
  test('finds the repository package instead of the Docs package', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'project-space-release-preview-'),
    );
    temporaryDirectories.push(root);
    const docs = join(root, 'apps/docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'project-space',
        version: '0.4.45',
      }),
    );
    writeFileSync(
      join(docs, 'package.json'),
      JSON.stringify({
        name: '@dotnaos/project-docs',
        version: '0.2.0',
      }),
    );

    expect(projectSpacePackageVersion(docs)).toBe('0.4.45');
  });

  test('fails closed when the repository package is unavailable', () => {
    expect(
      projectSpacePackageVersion('/missing', () => {
        throw new Error('missing');
      }),
    ).toBeUndefined();
  });

  test('shows tests only for the exact Preview build and version', () => {
    const parsed = parseReleaseEntryMdx(
      readFileSync(
        'apps/docs/content/docs/releases/entries/409.mdx',
        'utf8',
      ),
      '409.mdx',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const environment = {
      PROJECT_SPACE_BUILD_COMMIT: head,
      PROJECT_SPACE_PREVIEW_HEAD_SHA: head,
      PROJECT_SPACE_PREVIEW_MODE: '1',
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '409',
      PROJECT_SPACE_PREVIEW_REPOSITORY:
        'DotNaos/project-space',
    };

    expect(
      previewTestsForCurrentBuild(
        parsed.entry,
        environment,
        '0.4.47',
      ),
    ).toHaveLength(7);
    expect(
      previewTestsForCurrentBuild(
        parsed.entry,
        environment,
        '0.4.44',
      ),
    ).toBeUndefined();
  });
});
