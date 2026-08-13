import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('canonical Environment bootstrap', () => {
  test('makes the typed Project CLI launch the primary setup path', () => {
    const app = source('src/app/app.tsx');
    const page = source('apps/docs/content/docs/environments/setup.mdx');
    const command = source('cmd/project/environment_bootstrap.go');

    expect(app).toContain("window.location.pathname === '/environments/setup'");
    expect(app).toContain("window.location.replace('/docs/environments/setup')");
    expect(app).toContain("window.location.pathname === '/machines/connect'");
    expect(app).not.toContain("startsWith('/connector')");
    expect(page).toContain('project environment bootstrap');
    expect(page).toContain('project environment bootstrap <environment>');
    expect(page).toContain('project environment bootstrap\n```');
    expect(page).toContain('## Advanced overrides');
    expect(page).not.toContain('permanent Connector');
    expect(page).not.toContain('project connector install');
    expect(command).toContain('LaunchWorkspaceRuntime');
    expect(command).toContain('ManifestDigest: options.manifestDigest');
    expect(command).not.toContain('project connect');
    expect(command).not.toContain('connector service');
  });

  test('package installs retire the Connector without starting it', () => {
    const linux = source('packaging/linux/install-machine-tools.sh');
    const macos = source('packaging/macos/install-machine-tools.sh');
    const selfUpdate = source('cmd/project/self_update.go');

    expect(linux).not.toContain('connector_service_mode');
    expect(linux).not.toContain('external-connector-supervisor');
    expect(linux).toContain('systemctl --user stop "$retired_unit"');
    expect(linux).not.toContain('connector service start-if-connected');
    expect(linux).toContain('project environment bootstrap');
    expect(linux).not.toContain('Next: run %s/project connect');
    expect(macos).not.toContain('service_mode');
    expect(macos).toContain('launchctl bootout "$legacy_service"');
    expect(macos).toContain('launchctl bootout "$modern_service"');
    expect(macos).toContain('project environment bootstrap');
    expect(macos).not.toContain('connector service start-if-connected');
    expect(selfUpdate).toContain('verified Project CLI release');
    expect(selfUpdate).not.toContain('CLI and connector release');
  });
});
