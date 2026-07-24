import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexBinary } from '../server/codex-sessions/binary-resolver';

describe('Codex binary discovery', () => {
  test('skips a present but broken PATH shim and reports no working binary', () => {
    const result = resolveCodexBinary({
      environment: { PATH: '/broken/bin' },
      executable: () => true,
      platform: 'linux',
      validate: () => false
    });
    expect(result).toEqual({ attempted: ['/broken/bin/codex'] });
  });

  test('honors only an absolute explicit working override', () => {
    expect(resolveCodexBinary({
      environment: { PROJECT_CODEX_CLI_PATH: 'relative/codex' },
      executable: () => true,
      validate: () => true
    })).toEqual({ attempted: ['PROJECT_CODEX_CLI_PATH (not absolute)'] });

    expect(resolveCodexBinary({
      environment: { PROJECT_CODEX_CLI_PATH: '/opt/codex' },
      executable: () => true,
      validate: () => true
    }).path).toBe('/opt/codex');
  });

  test('uses only the adjacent signed runtime for a managed Linux connector', () => {
    const executable = '/home/test/.local/bin/.project-space-machine-tools/versions/0.4.15-release/project-space-connector';
    expect(resolveCodexBinary({
      environment: {
        PATH: '/untrusted/bin',
        PROJECT_CODEX_CLI_PATH: '/untrusted/override',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      executable: (path) => path.endsWith('/codex'),
      platform: 'linux',
      runtimeExecutable: executable,
      validate: (path) => path.endsWith('/codex')
    })).toEqual({
      attempted: [
        '/home/test/.local/bin/.project-space-machine-tools/versions/0.4.15-release/codex'
      ],
      path: '/home/test/.local/bin/.project-space-machine-tools/versions/0.4.15-release/codex'
    });
  });

  test('does not treat a similar install-source value as managed', () => {
    expect(resolveCodexBinary({
      environment: {
        PATH: '/normal/bin',
        PROJECT_SPACE_INSTALL_SOURCE: 'Managed'
      },
      executable: () => true,
      platform: 'linux',
      runtimeExecutable: '/managed/project-space-connector',
      validate: () => true
    }).path).toBe('/normal/bin/codex');
  });

  test('requires an exact, non-writable regular managed runtime and pinned version', async () => {
    const release = await mkdtemp(join(tmpdir(), 'project-managed-codex-'));
    const connector = join(release, 'project-space-connector');
    const codex = join(release, 'codex');
    const target = join(release, 'codex-target');
    await writeFile(connector, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 0.145.0\\n"\n', { mode: 0o755 });
    await writeFile(join(release, 'CODEX-VERSION'), '0.145.0\n', { mode: 0o600 });
    const options = {
      environment: { PROJECT_SPACE_INSTALL_SOURCE: 'managed' },
      platform: 'linux' as const,
      runtimeExecutable: connector
    };

    expect(resolveCodexBinary(options).path).toBe(codex);
    await chmod(codex, 0o775);
    expect(resolveCodexBinary(options).path).toBeUndefined();

    await unlink(codex);
    await writeFile(target, '#!/bin/sh\nprintf "codex-cli 0.145.0\\n"\n', { mode: 0o755 });
    await symlink(target, codex);
    expect(resolveCodexBinary(options).path).toBeUndefined();
  });
});
