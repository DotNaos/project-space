import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('canonical Environment bootstrap', () => {
  test('makes the typed Project CLI launch the primary setup path', () => {
    const page = source('src/features/connector-setup/components/connector-setup-page.tsx');
    const command = source('cmd/project/environment_bootstrap.go');

    expect(page).toContain('project environment bootstrap <environment-instance>');
    expect(page).toContain('without a permanent Connector');
    expect(page).not.toContain('Legacy Connector compatibility');
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

    expect(linux).toContain('auto)\n    connector_service_mode=managed');
    expect(linux).toContain('systemctl --user stop "$retired_unit"');
    expect(linux).not.toContain('connector service start-if-connected');
    expect(linux).toContain('project environment bootstrap');
    expect(linux).not.toContain('Next: run %s/project connect');
    expect(macos).toContain('elif [[ $service_mode == managed ]]');
    expect(macos).toContain('if [[ $service_mode == none ]]');
    expect(macos).toContain('project environment bootstrap');
    expect(macos).not.toContain('connector service start-if-connected');
    expect(selfUpdate).toContain('verified Project CLI release');
    expect(selfUpdate).not.toContain('CLI and connector release');
  });
});
