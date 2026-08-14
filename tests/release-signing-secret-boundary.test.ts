import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..');
const infisicalAction =
  'Infisical/secrets-action@8a06c1bdcd5b8635d510c52d4b57a92c1ccef785';
const releaseIdentity = '577f6b4c-943b-4bf5-94ac-07140f1e5b2d';

async function source(path: string) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

describe('release signing Infisical boundary', () => {
  test('the caller grants OIDC but forwards no long-lived secret', async () => {
    const workflow = await source('.github/workflows/release.yml');
    expect(workflow).toContain('manifest-sign:');
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
  });

  test('the reusable signer uses one fixed release identity and protected environment', async () => {
    const workflow = await source('.github/workflows/release-manifest-sign.yml');
    expect(workflow).toContain('environment: release-signing');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain(`uses: ${infisicalAction}`);
    expect(workflow).toContain(`identity-id: ${releaseIdentity}`);
    expect(workflow).toContain('project-slug: project-space-release-signing');
    expect(workflow).toContain('env-slug: prod');
    expect(workflow).toContain('oidc-audience: https://github.com/DotNaos');
    expect(workflow).not.toContain('actions/checkout@');
    expect(workflow).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(workflow).not.toContain('1password/');
    expect(workflow).not.toContain('op://');
  });

  test('keeps the private signing key in the isolated signer only', async () => {
    const macos = await source('.github/workflows/release-macos.yml');
    const manifest = await source('.github/workflows/release-manifest-sign.yml');
    expect(manifest).toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(macos).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(macos).not.toContain('environment: release-signing');
    expect(macos).not.toContain('Infisical/secrets-action@');
  });

  test('keeps retired probe workflows absent', async () => {
    for (const path of [
      '.github/workflows/macos-signing-identity-probe.yml',
      '.github/workflows/signing-secret-boundary-probe.yml',
      '.github/workflows/signing-secret-boundary-probe-reusable.yml'
    ]) {
      expect(await Bun.file(join(repositoryRoot, path)).exists()).toBe(false);
    }
  });
});
