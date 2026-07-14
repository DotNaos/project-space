import type { IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'bun:test';

import {
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
        PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:
          'project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
        PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: 'a'.repeat(64),
        PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION: 'v0.3.0'
      })
    ).toEqual({
      asset: 'project-space-machine-tools-darwin-arm64-v0.3.0.tar.gz',
      sha256: 'a'.repeat(64),
      version: 'v0.3.0'
    });
    expect(() =>
      connectorInstallerReleaseConfig({
        PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:
          'project-space-machine-tools-darwin-arm64-v0.4.0.tar.gz',
        PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256: 'a'.repeat(64),
        PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION: 'v0.3.0'
      })
    ).toThrow('must match');
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

  test('installs only the managed pinned bundle and refuses unsafe legacy replacement', () => {
    const script = connectorInstallScript('https://projects.os-home.net');

    expect(script).toContain('releases/download/$bundle_version/$bundle_asset');
    expect(script).not.toContain('/releases/latest/');
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('bundle_root="$tmp_dir/${bundle_asset%.tar.gz}"');
    expect(script).toContain('"$bundle_root/install.sh" --install-dir "$install_dir"');
    expect(script).not.toContain('install -m 0755 "$tmp_dir/project-space-connector"');
    expect(script).toContain('net.os-home.project-space.machine-connector-supervisor.plist');
    expect(script).toContain('the existing machine identity and settings were preserved');
    expect(script).toContain('connector-command-signing-public-key.pem');
    expect(script).toContain('release-manifest-signing-public-key.pem');
    expect(script).toContain('Automatic replacement is blocked because that identity cannot be preserved safely.');
    expect(script).toContain('"$install_dir/project" connect');
    expect(script).not.toContain('PROJECT_CONNECTOR_ENROLLMENT_CREDENTIAL');
    expect(script).not.toContain('PROJECT_SPACE_INSTALL_SOURCE');
    expect(script).not.toContain('<plist version=');
    expect(script.indexOf('Automatic replacement is blocked')).toBeLessThan(
      script.indexOf('"$bundle_root/install.sh" --install-dir "$install_dir"')
    );
    expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
  });
});
