import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('Windows release version', () => {
  test('matches the package, connector, and WinGet packaging test', async () => {
    const repositoryRoot = resolve(import.meta.dir, '..');
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')
    ) as { version: string };
    const connectorSource = await readFile(
      resolve(repositoryRoot, 'server/web-server.ts'),
      'utf8'
    );
    const packagingTest = await readFile(
      resolve(repositoryRoot, 'packaging/windows/test-release-packaging.ps1'),
      'utf8'
    );

    const connectorVersion = connectorSource.match(/const version = '([^']+)';/)?.[1];
    const packagingVersion = packagingTest.match(/\$version = '([^']+)'/)?.[1];

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(connectorVersion).toBe(packageJson.version);
    expect(packagingVersion).toBe(packageJson.version);
  });
});
