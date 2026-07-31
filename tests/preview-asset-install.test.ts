import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const installerPath = join(repositoryRoot, 'deploy/install-preview-assets.sh');
const assetNames = [
  'preview-runner.sh',
  'preview-reaper.sh',
  'preview-runtime-verification.sh',
  'preview-storage-policy.sh',
  'preview-ssh-entrypoint.sh',
  'preview-status-entrypoint.sh',
  'preview.compose.yml'
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-space-preview-assets-'));
  temporaryRoots.push(root);
  const source = join(root, 'source');
  const platform = join(root, 'platform');
  await mkdir(source);
  for (const asset of assetNames) {
    await copyFile(join(repositoryRoot, 'deploy', asset), join(source, asset));
  }
  return { platform, root, source };
}

function install(source: string, platform: string, commit: string) {
  return spawnSync('sh', [installerPath, source, commit], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_SPACE_PREVIEW_PLATFORM_ROOT: platform
    }
  });
}

describe('trusted Preview asset installation', () => {
  test('atomically activates one immutable runner and Compose release per exact main SHA', async () => {
    const { platform, source } = await createFixture();
    const firstCommit = 'a'.repeat(40);
    const secondCommit = 'b'.repeat(40);

    const first = install(source, platform, firstCommit);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`PROJECT_SPACE_PREVIEW_ASSETS=${firstCommit}`);

    const currentLink = join(platform, 'share/project-space-preview-current');
    const firstRelease = join(platform, 'share/project-space-preview-releases', firstCommit);
    expect(await readlink(currentLink)).toBe(firstRelease);
    expect(await readFile(join(firstRelease, 'asset-commit'), 'utf8')).toBe(`${firstCommit}\n`);
    expect((await stat(firstRelease)).mode & 0o777).toBe(0o755);
    expect(install(source, platform, firstCommit).status).toBe(0);
    expect(await readlink(currentLink)).toBe(firstRelease);

    await writeFile(
      join(source, 'preview.compose.yml'),
      `${await readFile(join(source, 'preview.compose.yml'), 'utf8')}\n# exact second release\n`
    );
    const second = install(source, platform, secondCommit);
    expect(second.status).toBe(0);

    const secondRelease = join(platform, 'share/project-space-preview-releases', secondCommit);
    expect(await readlink(currentLink)).toBe(secondRelease);
    expect(await readFile(join(secondRelease, 'preview.compose.yml'), 'utf8')).toContain(
      '# exact second release'
    );
    expect(await readFile(join(firstRelease, 'preview.compose.yml'), 'utf8')).not.toContain(
      '# exact second release'
    );
    expect((await lstat(currentLink)).isSymbolicLink()).toBe(true);

    for (const entrypoint of ['preview-ssh-entrypoint.sh', 'preview-status-entrypoint.sh']) {
      expect(await readFile(join(platform, 'share/project-space-preview', entrypoint), 'utf8'))
        .toBe(await readFile(join(source, entrypoint), 'utf8'));
    }
  });

  test('fails closed without changing the active release when staged input is unsafe', async () => {
    const { platform, root, source } = await createFixture();
    const firstCommit = 'c'.repeat(40);
    expect(install(source, platform, firstCommit).status).toBe(0);

    await rm(join(source, 'preview.compose.yml'));
    await symlink(join(root, 'outside-compose.yml'), join(source, 'preview.compose.yml'));
    await writeFile(join(root, 'outside-compose.yml'), 'services: {}\n');
    const rejected = install(source, platform, 'd'.repeat(40));

    expect(rejected.status).toBe(64);
    expect(rejected.stderr).toContain('Preview asset is missing or unsafe');
    expect(await readlink(join(platform, 'share/project-space-preview-current')))
      .toBe(join(platform, 'share/project-space-preview-releases', firstCommit));
  });

  test('rejects malformed shell assets before activation', async () => {
    const { platform, source } = await createFixture();
    await writeFile(join(source, 'preview-runner.sh'), '#!/bin/sh\nif\n');
    await chmod(join(source, 'preview-runner.sh'), 0o755);

    const rejected = install(source, platform, 'e'.repeat(40));

    expect(rejected.status).toBe(64);
    expect(rejected.stderr).toContain('invalid shell syntax');
    await expect(lstat(join(platform, 'share/project-space-preview-current'))).rejects.toThrow();
  });
});
