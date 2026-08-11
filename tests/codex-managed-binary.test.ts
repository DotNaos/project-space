import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitManagedCodexBinarySelection,
  managedCodexBinaryInstalled,
  provisionExactManagedCodexBinary,
  restorePreviousManagedCodexBinary
} from '../server/codex-daemon/managed-binary';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-codex-managed-'));
  cleanup.push(root);
  const codexHome = join(root, 'codex-home');
  const standalone = join(codexHome, 'packages', 'standalone');
  const releases = join(standalone, 'releases');
  const sourcePath = join(root, 'signed-codex');
  await mkdir(releases, { mode: 0o700, recursive: true });
  await writeFile(sourcePath, '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
  return {
    environment: {
      CODEX_HOME: codexHome,
      PROJECT_SPACE_INSTALL_SOURCE: 'managed'
    },
    releases,
    root,
    sourcePath,
    standalone
  };
}

async function packagedRelease(
  releases: string,
  name: string,
  body = '#!/bin/sh\necho codex-cli 0.145.0\n'
) {
  const release = join(releases, name);
  await mkdir(join(release, 'bin'), { mode: 0o700, recursive: true });
  await writeFile(join(release, 'bin', 'codex'), body, { mode: 0o755 });
  await symlink('bin/codex', join(release, 'codex'));
  return release;
}

describe('immutable managed Codex selection', () => {
  test('selects a digest release atomically and preserves the prior packaged release', async () => {
    const root = await fixture();
    const oldRelease = await packagedRelease(root.releases, '0.145.0-upstream');
    await symlink(oldRelease, join(root.standalone, 'current'));

    const first = await provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    const selectedTarget = await readlink(join(root.standalone, 'current'));
    const rollbackTarget = await readlink(first.rollbackPointerPath);

    expect(first).toMatchObject({ changed: true });
    expect(first.releaseName).toMatch(/^0\.146\.0-project-space-[0-9a-f]{64}$/);
    expect(selectedTarget).toBe(`releases/${first.releaseName}`);
    expect(rollbackTarget).toBe('releases/0.145.0-upstream');
    expect(await readFile(join(root.standalone, 'current', 'codex'), 'utf8'))
      .toBe(await readFile(root.sourcePath, 'utf8'));
    expect(await readFile(join(oldRelease, 'bin', 'codex'), 'utf8'))
      .toContain('0.145.0');
    expect(await readFile(join(first.rollbackPointerPath, 'codex'), 'utf8'))
      .toContain('0.145.0');
    expect(await managedCodexBinaryInstalled(root.environment)).toBe(true);

    const second = await provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    expect(second).toMatchObject({ changed: false, releaseName: first.releaseName });
    expect(await readlink(join(root.standalone, 'current'))).toBe(selectedTarget);
    expect((await readdir(root.releases)).sort()).toEqual([
      '0.145.0-upstream',
      first.releaseName
    ].sort());
  });

  test('migrates a legacy current directory without deleting its previous bytes', async () => {
    const root = await fixture();
    const current = join(root.standalone, 'current');
    await mkdir(current, { mode: 0o700 });
    await writeFile(join(current, 'codex'), '#!/bin/sh\necho legacy\n', { mode: 0o755 });

    const result = await provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });

    expect((await lstat(current)).isSymbolicLink()).toBe(true);
    expect(result.previousTarget)
      .toMatch(/^releases\/legacy-[0-9a-f]{16}-project-space-[0-9a-f]{64}$/);
    expect(await readlink(result.rollbackPointerPath)).toBe(result.previousTarget);
    expect(await readFile(join(result.rollbackPointerPath, 'codex'), 'utf8'))
      .toContain('legacy');
    expect(await readFile(join(current, 'codex'), 'utf8'))
      .toBe(await readFile(root.sourcePath, 'utf8'));
  });

  test('keeps a legacy current intact until an accepted update commit and recovers its swap', async () => {
    const root = await fixture();
    const current = join(root.standalone, 'current');
    const hold = join(root.standalone, '.project-space-legacy-current');
    const legacyBody = '#!/bin/sh\necho codex-cli 0.145.0\n';
    await mkdir(current, { mode: 0o700 });
    await writeFile(join(current, 'codex'), legacyBody, { mode: 0o755 });

    const staged = await provisionExactManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-legacy',
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    expect((await lstat(current)).isDirectory()).toBe(true);
    expect(await readFile(join(current, 'codex'), 'utf8')).toBe(legacyBody);
    expect(staged.previousTarget)
      .toMatch(/^releases\/legacy-[0-9a-f]{16}-project-space-[0-9a-f]{64}$/);

    // Model process death after the legacy directory was durably moved aside
    // but before the selected pointer was published.
    await rename(current, hold);
    await expect(commitManagedCodexBinarySelection({
      environment: root.environment,
      operationId: 'connector-update-legacy'
    })).resolves.toMatchObject({ changed: true, found: true });
    expect((await lstat(current)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(current, 'codex'), 'utf8'))
      .toBe(await readFile(root.sourcePath, 'utf8'));
    await expect(lstat(hold)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(restorePreviousManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-legacy'
    })).resolves.toMatchObject({ changed: true, found: true });
    expect(await readFile(join(current, 'codex'), 'utf8')).toBe(legacyBody);
  });

  test('reclaims a crashed repair lock but never steals one from a live process', async () => {
    const root = await fixture();
    const oldRelease = await packagedRelease(root.releases, '0.145.0-upstream');
    await symlink(oldRelease, join(root.standalone, 'current'));
    const lock = join(root.standalone, '.project-space-provision.lock');
    const owner = join(lock, 'owner.json');
    await mkdir(lock, { mode: 0o700 });
    await writeFile(owner, `${JSON.stringify({
      pid: 2_147_483_647,
      schema: 'project-space.managed-codex-lock/v1',
      token: 'a'.repeat(32)
    })}\n`, { mode: 0o600 });

    await expect(provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    })).resolves.toMatchObject({ changed: true });
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(lock, { mode: 0o700 });
    await writeFile(owner, `${JSON.stringify({
      pid: process.pid,
      schema: 'project-space.managed-codex-lock/v1',
      token: 'b'.repeat(32)
    })}\n`, { mode: 0o600 });
    await expect(provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    })).rejects.toThrow('already in progress');
    expect((await lstat(lock)).isDirectory()).toBe(true);
  });

  test('restores the exact previous pointer and bytes after pending health fails', async () => {
    const root = await fixture();
    const oldRelease = await packagedRelease(root.releases, '0.145.0-upstream');
    await symlink(oldRelease, join(root.standalone, 'current'));

    const selected = await provisionExactManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-576',
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    await provisionExactManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-576',
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    expect(await readlink(join(root.standalone, 'current')))
      .toBe(oldRelease);

    await expect(commitManagedCodexBinarySelection({
      environment: root.environment,
      operationId: 'connector-update-576'
    })).resolves.toMatchObject({ changed: true, found: true });
    expect(await readlink(join(root.standalone, 'current')))
      .toBe(`releases/${selected.releaseName}`);

    const restored = await restorePreviousManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-576'
    });

    expect(restored).toMatchObject({
      changed: true,
      found: true,
      restoredTarget: 'releases/0.145.0-upstream',
      selectedTarget: `releases/${selected.releaseName}`
    });
    expect(await readlink(join(root.standalone, 'current')))
      .toBe('releases/0.145.0-upstream');
    expect(await readFile(join(root.standalone, 'current', 'codex'), 'utf8'))
      .toContain('0.145.0');
    expect(await readFile(join(root.releases, selected.releaseName, 'codex'), 'utf8'))
      .toBe(await readFile(root.sourcePath, 'utf8'));
    await expect(restorePreviousManagedCodexBinary({
      environment: root.environment,
      operationId: 'connector-update-576'
    })).resolves.toMatchObject({ changed: false, found: true });
  });

  test('keeps the previous pointer across timeout, process exit, and staged reconnect', async () => {
    const root = await fixture();
    const oldRelease = await packagedRelease(root.releases, '0.145.0-upstream');
    await symlink(oldRelease, join(root.standalone, 'current'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await provisionExactManagedCodexBinary({
        environment: root.environment,
        operationId: 'connector-update-no-decision',
        sourcePath: root.sourcePath,
        version: '0.146.0'
      });
      expect(await readlink(join(root.standalone, 'current')))
        .toBe(oldRelease);
      expect(await readFile(join(root.standalone, 'current', 'codex'), 'utf8'))
        .toContain('0.145.0');
    }
  });

  test('restores the intact previous release when the rejected release is corrupt or missing', async () => {
    for (const damage of ['corrupt', 'missing'] as const) {
      const root = await fixture();
      const oldRelease = await packagedRelease(root.releases, '0.145.0-upstream');
      await symlink(oldRelease, join(root.standalone, 'current'));
      const operationId = `connector-update-${damage}`;
      const selected = await provisionExactManagedCodexBinary({
        environment: root.environment,
        operationId,
        sourcePath: root.sourcePath,
        version: '0.146.0'
      });
      await commitManagedCodexBinarySelection({
        environment: root.environment,
        operationId
      });
      const rejectedRelease = join(root.releases, selected.releaseName);
      if (damage === 'missing') {
        await rm(rejectedRelease, { force: true, recursive: true });
      } else {
        await writeFile(join(rejectedRelease, 'bin', 'codex'), 'corrupt\n', { mode: 0o755 });
      }

      await expect(restorePreviousManagedCodexBinary({
        environment: root.environment,
        operationId
      })).resolves.toMatchObject({ changed: true, found: true });
      expect(await readlink(join(root.standalone, 'current')))
        .toBe('releases/0.145.0-upstream');
      expect(await readFile(join(root.standalone, 'current', 'codex'), 'utf8'))
        .toContain('0.145.0');
    }
  });

  test('never overwrites an existing digest release and rejects unsafe paths', async () => {
    const root = await fixture();
    const first = await provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    });
    const immutableBinary = join(root.releases, first.releaseName, 'bin', 'codex');
    await chmod(immutableBinary, 0o755);
    await writeFile(immutableBinary, '#!/bin/sh\necho modified\n');
    await chmod(immutableBinary, 0o755);

    await expect(provisionExactManagedCodexBinary({
      environment: root.environment,
      sourcePath: root.sourcePath,
      version: '0.146.0'
    })).rejects.toThrow('release bytes do not match');
    expect(await readFile(immutableBinary, 'utf8')).toContain('modified');

    const escaped = await fixture();
    const external = join(escaped.root, 'external-release');
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, 'codex'), '#!/bin/sh\necho external\n', { mode: 0o755 });
    await symlink(external, join(escaped.standalone, 'current'));
    await expect(provisionExactManagedCodexBinary({
      environment: escaped.environment,
      sourcePath: escaped.sourcePath,
      version: '0.146.0'
    })).rejects.toThrow('outside its package root');
    expect(await readFile(join(external, 'codex'), 'utf8')).toContain('external');

    await chmod(escaped.sourcePath, 0o777);
    await expect(provisionExactManagedCodexBinary({
      environment: escaped.environment,
      sourcePath: escaped.sourcePath,
      version: '0.146.0'
    })).rejects.toThrow('not a secure executable');
  });
});
