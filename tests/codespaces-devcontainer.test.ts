import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('Codespaces runner devcontainer', () => {
  test('installs and verifies the SSH server required by GitHub diagnostics', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as { features?: Record<string, unknown> };
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(
      devcontainer.features?.['ghcr.io/devcontainers/features/sshd:1']
    ).toEqual({ version: 'latest' });
    expect(verification).toMatch(
      /for command_name in [^\n]*\bsshd\b/
    );
  });

  test('installs and verifies node-gyp before native dependencies', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as { features?: Record<string, unknown> };
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(
      devcontainer.features?.['ghcr.io/devcontainers/features/python:1']
    ).toEqual({ version: 'os-provided', installTools: false });
    expect(bootstrap).toMatch(/readonly node_gyp_version="\d+\.\d+\.\d+"/);
    expect(bootstrap.indexOf('bun add --global')).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('bun add --global')).toBeLessThan(
      bootstrap.indexOf('bun install --frozen-lockfile')
    );
    expect(verification).toMatch(
      /for command_name in [^\n]*\bnode-gyp\b/
    );
    expect(verification).toContain("python3 -c 'import shlex'");
  });

  test('pins the released connector that retains Codespaces metadata', async () => {
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');

    expect(bootstrap).toContain('readonly project_version="0.10.6"');
    expect(bootstrap).toContain(
      'readonly archive_sha256="ecc6f972a65dad1cfdae48ee4be84263d5a7239b76a0b6519fe02767c200ad64"'
    );
  });
});
