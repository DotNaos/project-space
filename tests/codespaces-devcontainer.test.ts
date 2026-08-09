import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('Codespaces runner devcontainer', () => {
  test('uses the pinned prebuilt image with the required runner toolchain', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as {
      features?: Record<string, unknown>;
      image?: string;
      remoteEnv?: { PATH?: string };
      remoteUser?: string;
    };
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(devcontainer.image).toBe(
      'mcr.microsoft.com/devcontainers/universal:6.1.1-linux@sha256:cb1ccdf5e3c10b4134ffe8f2c03e8481e7c41058d27a70192fa54146a8c327c2'
    );
    expect(devcontainer.remoteUser).toBe('codespace');
    expect(devcontainer.remoteEnv?.PATH).toStartWith('/home/codespace/');
    expect(devcontainer.features).toBeUndefined();
    expect(verification).toMatch(
      /for command_name in [^\n]*\bsshd\b/
    );
  });

  test('installs node-gyp without blocking on repository dependencies', async () => {
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(bootstrap).toMatch(/readonly node_gyp_version="\d+\.\d+\.\d+"/);
    expect(bootstrap.indexOf('bun add --global')).toBeGreaterThan(-1);
    expect(bootstrap).not.toContain('bun install --frozen-lockfile');
    expect(verification).toMatch(
      /for command_name in [^\n]*\bnode-gyp\b/
    );
    expect(verification).toContain("python3 -c 'import shlex'");
  });

  test('prepares reusable runner tools before the fast connection step', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as {
      onCreateCommand?: string;
      postCreateCommand?: string;
      postStartCommand?: string;
    };
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');

    expect(devcontainer.onCreateCommand).toBe(
      'bash .devcontainer/bootstrap.sh'
    );
    expect(devcontainer.postCreateCommand).toBe(
      'bash .devcontainer/start-runner.sh'
    );
    expect(devcontainer.postStartCommand).toBe(
      'bash .devcontainer/start-runner.sh'
    );
    expect(bootstrap).not.toContain('.devcontainer/start-runner.sh');
    expect(bootstrap).not.toContain('bun install --frozen-lockfile');
  });

  test('pins the released connector that retains Codespaces metadata', async () => {
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');

    expect(bootstrap).toContain('readonly project_version="0.10.6"');
    expect(bootstrap).toContain(
      'readonly archive_sha256="ecc6f972a65dad1cfdae48ee4be84263d5a7239b76a0b6519fe02767c200ad64"'
    );
  });
});
