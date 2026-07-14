import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { connectorBuildIdentity } from '../packaging/release/build-connector';

describe('Windows release version', () => {
  test('matches the package, connector, and WinGet packaging test', async () => {
    const repositoryRoot = resolve(import.meta.dir, '..');
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')
    ) as { version: string };
    const packagingTest = await readFile(
      resolve(repositoryRoot, 'packaging/windows/test-release-packaging.ps1'),
      'utf8'
    );

    const connectorIdentity = await connectorBuildIdentity({
      GITHUB_SHA: '1111111111111111111111111111111111111111'
    });
    const packagingVersion = packagingTest.match(/\$version = '([^']+)'/)?.[1];

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(connectorIdentity).toEqual({
      buildId: '1111111111111111111111111111111111111111',
      releaseId: `v${packageJson.version}`,
      version: packageJson.version
    });
    expect(packagingVersion).toBe(packageJson.version);
  });
});
