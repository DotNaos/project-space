import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

test('the Codespace bootstrap is a no-download idempotent operation when exact tools exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-space-devcontainer-'));
  temporaryDirectories.push(root);
  const userHome = join(root, 'home');
  const localBin = join(userHome, '.local', 'bin');
  const bunBin = join(userHome, '.bun', 'bin');
  const fakeBin = join(root, 'fake-bin');
  const managedBin = join(localBin, '.project-space-machine-tools', 'current');
  await Promise.all([
    mkdir(localBin, { mode: 0o700, recursive: true }),
    mkdir(bunBin, { mode: 0o700, recursive: true }),
    mkdir(fakeBin, { mode: 0o700, recursive: true }),
    mkdir(managedBin, { mode: 0o700, recursive: true })
  ]);

  await Promise.all([
    executable(
      join(bunBin, 'bun'),
      `case "\${1:-}" in
  --version) echo 1.3.14 ;;
  install) exit 0 ;;
  run) test "\${2:-}" = check:package-manager && echo "Bun-only package-manager policy passed for Bun 1.3.14." ;;
  *) exit 90 ;;
esac`
    ),
    executable(join(bunBin, 'codex'), 'test "${1:-}" = --version && echo "codex-cli 0.146.1"'),
    executable(join(localBin, 'project'), 'test "${1:-}" = --version && echo "project version 0.4.61"'),
    executable(join(localBin, 'project-space-connector'), 'test "${1:-}" = --version && echo "0.4.61"'),
    executable(
      join(managedBin, 'codex'),
      `case "\${1:-}" in
  --version) echo "codex-cli 0.145.0" ;;
  app-server) echo "\$*" >> "${join(root, 'daemon-called')}" ;;
  *) exit 90 ;;
esac`
    ),
    executable(
      join(fakeBin, 'python3'),
      'test "${1:-}" = -c && test "${2:-}" = "import shlex"'
    ),
    executable(join(fakeBin, 'node'), 'test "${1:-}" = --version && echo "v24.15.0"'),
    executable(join(fakeBin, 'node-gyp'), 'test "${1:-}" = --version && echo "v13.0.1"'),
    executable(join(fakeBin, 'go'), 'echo "go version go1.26.5 linux/amd64"'),
    executable(join(fakeBin, 'gh'), 'test "${1:-}" = --version && echo "gh version 2.97.0 (2026-07-31)"'),
    executable(join(fakeBin, 'tmux'), 'test "${1:-}" = -V && echo "tmux 3.4"'),
    executable(join(fakeBin, 'docker'), 'test "${1:-}" = info'),
    executable(join(fakeBin, 'curl'), `echo called >> "${join(root, 'curl-called')}"; exit 97`)
  ]);

  const environment = {
    ...process.env,
    CODEX_HOME: join(userHome, '.codex'),
    HOME: userHome,
    PATH: `${fakeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  };
  const first = spawnSync('/bin/bash', ['.devcontainer/bootstrap.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment
  });
  const second = spawnSync('/bin/bash', ['.devcontainer/bootstrap.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment
  });

  expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
  expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });
  const devcontainer = await Bun.file(join(process.cwd(), '.devcontainer', 'devcontainer.json')).json();
  expect(devcontainer.features['ghcr.io/devcontainers/features/python:1']).toEqual({
    installTools: false,
    version: 'os-provided'
  });
  expect(devcontainer.features['ghcr.io/devcontainers/features/node:2']).toEqual({
    nodeGypDependencies: true,
    pnpmVersion: 'none',
    version: '24.15.0'
  });
  expect(devcontainer.features['ghcr.io/devcontainers/features/github-cli:1']).toEqual({
    version: '2.97.0'
  });
  expect(devcontainer.features['ghcr.io/devcontainers-extra/features/tmux-apt-get:1.0.17']).toEqual({});
  expect(devcontainer.postStartCommand).toBe('bash .devcontainer/start-services.sh');
  expect(devcontainer.overrideFeatureInstallOrder).toEqual([
    'ghcr.io/devcontainers/features/python',
    'ghcr.io/devcontainers/features/node'
  ]);
  expect(first.stdout).toContain('Codespace readiness passed');
  expect(second.stdout).toContain('Codespace readiness passed');
  expect(await readFile(join(userHome, '.codex', 'config.toml'), 'utf8')).toBe(
    await readFile(join(process.cwd(), '.codex', 'config.toml'), 'utf8')
  );
  expect(await readFile(join(userHome, '.codex', '.project-space-config.sha256'), 'utf8')).toMatch(
    /^[a-f0-9]{64}\n$/
  );
  expect(await readFile(join(userHome, '.codex', 'packages', 'standalone', 'current', 'codex'), 'utf8')).toBe(
    await readFile(join(managedBin, 'codex'), 'utf8')
  );
  expect((await readFile(join(root, 'daemon-called'), 'utf8')).trim().split('\n')).toHaveLength(4);
  expect(Bun.file(join(root, 'curl-called')).size).toBe(0);
});

async function executable(path: string, body: string) {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
}
