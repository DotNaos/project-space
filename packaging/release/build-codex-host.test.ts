import { describe, expect, test } from 'bun:test';

import {
  codexHostBuildArguments,
  codexHostBuildIdentity
} from './build-codex-host';

describe('release Codex host build identity', () => {
  test('embeds the exact version, release, and full build SHA', async () => {
    const identity = await codexHostBuildIdentity({
      GITHUB_SHA: 'b'.repeat(40),
      PROJECT_RELEASE_SOURCE_SHA: 'a'.repeat(40),
      RELEASE_ID: 'v1.2.3',
      VERSION: '1.2.3'
    });
    const arguments_ = codexHostBuildArguments(
      'bun-linux-x64',
      'dist/linux/project-codex-host',
      identity
    );

    expect(identity).toEqual({
      buildId: 'a'.repeat(40),
      releaseId: 'v1.2.3',
      version: '1.2.3'
    });
    expect(arguments_).toContain('__PROJECT_SPACE_VERSION__="1.2.3"');
    expect(arguments_).toContain('__PROJECT_SPACE_RELEASE_ID__="v1.2.3"');
    expect(arguments_).toContain(`__PROJECT_SPACE_BUILD_ID__="${'a'.repeat(40)}"`);
    expect(arguments_).toContain('--no-compile-autoload-dotenv');
    expect(arguments_).toContain('server/workspace-runtime-codex-host/cli.ts');
  });

  test('rejects mutable or mismatched release identity', async () => {
    await expect(codexHostBuildIdentity({
      GITHUB_SHA: 'a'.repeat(40),
      RELEASE_ID: 'latest',
      VERSION: '1.2.3'
    })).rejects.toThrow('exact release');
    expect(() => codexHostBuildArguments('bun-windows-x64', 'project-codex-host.exe', {
      buildId: 'short', releaseId: 'v1.2.3', version: '1.2.3'
    })).toThrow('full commit SHA');
  });
});
