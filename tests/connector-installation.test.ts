import type { IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  connectorEnrollmentTtlSeconds,
  connectorInstallScript,
  connectorInstallerReleaseConfig,
  requestPublicOrigin
} from '../server/connector-installation';

const originalPublicOrigin = process.env.PROJECT_SPACE_PUBLIC_ORIGIN;

afterEach(() => {
  if (originalPublicOrigin === undefined) {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;
  } else {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});

function request(
  headers: IncomingMessage['headers'],
  encrypted = false
) {
  return {
    headers,
    socket: { encrypted }
  } as IncomingMessage;
}

describe('connector installation origin', () => {
  test('uses an explicitly configured deployment origin', () => {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = 'https://beta.projects.os-home.net';

    expect(requestPublicOrigin(request({ host: 'attacker.invalid' }))).toBe(
      'https://beta.projects.os-home.net'
    );
  });

  test('accepts a plain local origin and rejects unsafe forwarded hosts', () => {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;

    expect(requestPublicOrigin(request({ host: '127.0.0.1:4173' }))).toBe(
      'http://127.0.0.1:4173'
    );
    expect(
      requestPublicOrigin(
        request({
          host: '127.0.0.1:4173',
          'x-forwarded-host': 'example.com/$(touch injected)',
          'x-forwarded-proto': 'https'
        })
      )
    ).toBe('https://projects.os-home.net');
  });

  test('quotes the trusted hub origin in the generated shell script', () => {
    expect(connectorInstallScript('https://projects.os-home.net')).toContain(
      "hub_url='https://projects.os-home.net'"
    );
  });

  test('requires a pinned release tag and SHA-256 checksum', () => {
    expect(
      connectorInstallerReleaseConfig({
        PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET: 'project-space-tools-darwin-arm64.tar.gz',
        PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: 'a'.repeat(64),
        PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION: 'v0.3.0'
      })
    ).toEqual({
      asset: 'project-space-tools-darwin-arm64.tar.gz',
      sha256: 'a'.repeat(64),
      version: 'v0.3.0'
    });
    expect(() =>
      connectorInstallerReleaseConfig({
        PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: 'a'.repeat(64),
        PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION: 'latest'
      })
    ).toThrow('PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION');
    expect(() =>
      connectorInstallerReleaseConfig({
        PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: 'a'.repeat(64)
      })
    ).toThrow('PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION');
  });

  test('installs the pinned two-binary bundle with a launchd-safe command path', () => {
    const script = connectorInstallScript('https://projects.os-home.net');

    expect(connectorEnrollmentTtlSeconds).toBe(15 * 60);
    expect(script).toContain('releases/download/$bundle_version/$bundle_asset');
    expect(script).not.toContain('/releases/latest/');
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('"$tmp_dir/project-space-connector" "$install_dir/project-space-connector"');
    expect(script).toContain('"$tmp_dir/project" "$install_dir/project"');
    expect(script).toContain('<key>PROJECT_CLI_PATH</key>');
    expect(script).toContain('$install_dir:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
  });
});
