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
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(bootstrap).toMatch(/readonly node_gyp_version="\d+\.\d+\.\d+"/);
    expect(bootstrap.indexOf('bun add --global')).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('bun add --global')).toBeLessThan(
      bootstrap.indexOf('bun install --frozen-lockfile')
    );
    expect(verification).toMatch(
      /for command_name in [^\n]*\bnode-gyp\b/
    );
  });
});
