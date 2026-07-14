import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');

async function source(path: string) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

describe('connector release and production deployment contract', () => {
  test('pins the next immutable semantic release consistently', async () => {
    const packageJson = JSON.parse(await source('package.json'));
    const buildInfo = await source('server/connector-build-info.ts');
    const windowsPackaging = await source('packaging/windows/test-release-packaging.ps1');
    const windowsDocumentation = await source('docs/windows-installation.md');

    expect(packageJson.version).toBe('0.4.4');
    expect(buildInfo).toContain("const developmentVersion = '0.4.4';");
    expect(windowsPackaging).toContain("$version = '0.4.4'");
    expect(windowsPackaging).toContain('/releases/download/v0.4.4/');
    expect(windowsDocumentation).toContain('DotNaos\\Project\\0.4.4');
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'main.projectMachineClientReleaseID=v$npm_package_version'
    );
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'main.projectMachineClientBuildID=$build_sha'
    );
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'test -n "$PROJECT_MACOS_SIGN_KEYCHAIN"'
    );
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'codesign --force --keychain "$PROJECT_MACOS_SIGN_KEYCHAIN"'
    );
  });

  test('derives both public trust roots only inside the release workflow', async () => {
    const workflow = await source('.github/workflows/release.yml');

    expect(workflow).toContain(
      'PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64: op://projects/project-connector-command-signing-key/private_key_b64'
    );
    expect(workflow).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64: op://projects/project-space-release-manifest-signing-key/private_key_b64'
    );
    expect(workflow).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: op://projects/project-space-release-manifest-signing-key/public_key_b64'
    );
    expect(workflow).toContain('bun packaging/release/derive-trust-roots.ts derive');
    expect(workflow).toContain('name: Confirm stored release trust root');
    expect(workflow).toContain(
      'cmp "$stored_public_key" \\\n            "$RUNNER_TEMP/connector-runtime-trust-roots/release-manifest-signing-public-key.pem"'
    );
    expect(workflow).toContain('name: connector-runtime-trust-roots');
    expect(workflow).toContain('connector-command-signing-public-key.pem');
    expect(workflow).toContain('release-manifest-signing-public-key.pem');
    expect(workflow).toContain('main.projectMachineClientReleaseID=v$env:VERSION');
    expect(workflow).toContain('main.projectMachineClientBuildID=$env:GITHUB_SHA');
    expect(workflow).toContain('main.projectMachineClientReleaseID=v$VERSION');
    expect(workflow).toContain('main.projectMachineClientBuildID=$GITHUB_SHA');
    expect(workflow).toContain(
      'security list-keychains -d user > "$original_keychains_file"'
    );
    expect(workflow).toContain('umask 077');
    expect(workflow).toContain('-passin env:CERTIFICATE_PASSWORD');
    expect(workflow).toContain(
      'security import "$RUNNER_TEMP/project-space-release.pem" -f pemseq -k "$keychain" -T /usr/bin/codesign'
    );
    expect(workflow).not.toContain('security import "$RUNNER_TEMP/project-space-release.pem" -x');
    expect(workflow).not.toContain('security import "$RUNNER_TEMP/project-space-release.p12"');
    expect(workflow).not.toContain('-P "$CERTIFICATE_PASSWORD"');
    expect(workflow).toContain(
      'security list-keychains -d user -s "$keychain" "${original_keychains[@]}"'
    );
    expect(workflow).toContain(
      'echo "PROJECT_MACOS_SIGN_KEYCHAIN=$keychain" >> "$GITHUB_ENV"'
    );
    expect(workflow).toContain('if: always() && github.ref_type == \'tag\'');
    expect(workflow).toContain('security delete-keychain "$keychain" || record_cleanup_failure $?');
    expect(workflow).toContain('"$RUNNER_TEMP/project-space-release.pem"');
    expect(workflow).toContain('"$original_keychains_file" || record_cleanup_failure $?');
    expect(workflow).toContain('exit "$restore_status"');

    const snapshotIndex = workflow.indexOf(
      'security list-keychains -d user > "$original_keychains_file"'
    );
    const addIndex = workflow.indexOf(
      'security list-keychains -d user -s "$keychain" "${original_keychains[@]}"'
    );
    const buildIndex = workflow.indexOf('bun run build:machine-tools:macos-arm64');
    const restoreIndex = workflow.indexOf(
      'security list-keychains -d user -s "${original_keychains[@]}" || record_cleanup_failure $?'
    );
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(snapshotIndex);
    expect(buildIndex).toBeGreaterThan(addIndex);
    expect(restoreIndex).toBeGreaterThan(buildIndex);
  });

  test('deploys the public root and derives the approved release without fetching it', async () => {
    const workflow = await source('.github/workflows/deploy-production.yml');
    const deployConfig = await source('deploy/deploy.yaml');
    const compose = await source('deploy/compose.yml');

    expect(workflow).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: op://projects/project-space-release-manifest-signing-key/public_key_b64'
    );
    expect(workflow).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: $\{{ steps.deploy-secrets.outputs.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64 }}'
    );
    expect(deployConfig).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: op://projects/project-space-release-manifest-signing-key/public_key_b64'
    );
    expect(compose).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: ${PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64:-}'
    );
    expect(compose).toContain(
      'PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: v${PROJECT_SPACE_BUILD_VERSION:-}'
    );
    expect(compose).not.toContain('PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:');
    expect(compose).not.toContain('PROJECT_SPACE_CONNECTOR_BUNDLE_SHA256:');
    expect(compose).not.toContain('PROJECT_SPACE_CONNECTOR_BUNDLE_VERSION:');
    expect(workflow).not.toContain('release-manifest-cli.ts verify');
    expect(deployConfig).not.toContain('workflow-pinned');
    expect(deployConfig).not.toContain('workflow-verified');
    expect(workflow).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(deployConfig).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(compose).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
  });
});
