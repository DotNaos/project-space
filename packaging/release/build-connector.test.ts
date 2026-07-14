import { describe, expect, test } from 'bun:test';

import {
  connectorBuildArguments,
  connectorBuildIdentity
} from './build-connector';

describe('release connector build identity', () => {
  test('embeds the exact version, release, and full build SHA', async () => {
    const identity = await connectorBuildIdentity({
      GITHUB_SHA: 'a'.repeat(40),
      RELEASE_ID: 'v1.2.3',
      VERSION: '1.2.3'
    });
    const arguments_ = connectorBuildArguments(
      'bun-linux-x64',
      'dist/linux/project-space-connector',
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
  });

  test('rejects mutable or mismatched release identity', async () => {
    await expect(connectorBuildIdentity({
      GITHUB_SHA: 'a'.repeat(40),
      RELEASE_ID: 'latest',
      VERSION: '1.2.3'
    })).rejects.toThrow('exact release');
    expect(() => connectorBuildArguments('bun-windows-x64', 'connector.exe', {
      buildId: 'short', releaseId: 'v1.2.3', version: '1.2.3'
    })).toThrow('full commit SHA');
  });
});
