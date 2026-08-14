import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repositoryRoot = resolve(import.meta.dir, '..');

describe('setup documentation installation commands', () => {
  test('uses the supported Homebrew HEAD update command', async () => {
    const setup = await readFile(
      resolve(repositoryRoot, 'apps/docs/content/docs/setup.mdx'),
      'utf8',
    );

    expect(setup).toContain(
      'brew upgrade --fetch-HEAD DotNaos/project-space/project',
    );
    expect(setup).not.toContain('brew reinstall --HEAD');
  });
});
