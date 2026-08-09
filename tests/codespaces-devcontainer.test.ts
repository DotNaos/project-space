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
});
