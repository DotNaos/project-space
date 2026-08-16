import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { shouldBuildMobilePrototype } from '../scripts/build-project';

const previewWebDockerfile = new URL(
  '../deploy/preview.web.Dockerfile',
  import.meta.url
);
const productionWebDockerfile = new URL('../deploy/Dockerfile', import.meta.url);
const productionComposeFile = new URL('../deploy/compose.yml', import.meta.url);
const deploymentConfigFile = new URL('../deploy/deploy.yaml', import.meta.url);
const tailscaleOAuthComposeFile = new URL('../deploy/compose.tailscale-oauth.yml', import.meta.url);
const previewComposeFile = new URL('../deploy/preview.compose.yml', import.meta.url);

describe('Project build routing', () => {
  test('keeps the aggregate build complete outside a trusted web image', () => {
    expect(shouldBuildMobilePrototype({})).toBe(true);
    expect(
      shouldBuildMobilePrototype({
        PROJECT_SPACE_BUILD_COMMIT: 'a'.repeat(40)
      })
    ).toBe(true);
    expect(
      shouldBuildMobilePrototype({
        VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_public'
      })
    ).toBe(true);
  });

  test('leaves mobile to the separate image during a trusted web build', () => {
    expect(
      shouldBuildMobilePrototype({
        PROJECT_SPACE_BUILD_COMMIT: 'a'.repeat(40),
        VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_public'
      })
    ).toBe(false);
  });

  test('builds only web assets in the trusted Preview web image', async () => {
    const dockerfile = await readFile(previewWebDockerfile, 'utf8');

    expect(dockerfile).toContain('&& bun run build:web');
    expect(dockerfile).not.toContain('&& bun run build\n');
    expect(dockerfile).not.toContain('apps/mobile');
  });

  test('keeps the exact-source changelog in the Preview web runtime', async () => {
    const dockerfile = await readFile(previewWebDockerfile, 'utf8');

    expect(dockerfile).toContain(
      'COPY --from=build /workspace/apps/docs/content/docs/changelog/entries.json'
    );
    expect(dockerfile).toContain(
      'RUN bun -e "await import(\'./server/project-space-api-public-routes.ts\')"'
    );
  });

  test('keeps server-side changelog modules in the production web runtime', async () => {
    const dockerfile = await readFile(productionWebDockerfile, 'utf8');

    expect(dockerfile).toContain(
      'COPY --from=build /workspace/apps/docs/lib/releases /workspace/apps/docs/lib/releases'
    );
    expect(dockerfile).toContain(
      'RUN bun -e "await import(\'./server/project-space-api-public-routes.ts\')"'
    );
  });

  test('trusts only the read-only backend repository mounted into the production runtime', async () => {
    const dockerfile = await readFile(productionWebDockerfile, 'utf8');

    expect(dockerfile).toContain(
      'git config --system --add safe.directory /workspace/backend-repo'
    );
    expect(dockerfile).not.toContain('safe.directory *');
  });

  test('reads Preview inventory from the production read-only state mount', async () => {
    const compose = await readFile(productionComposeFile, 'utf8');

    expect(compose).toContain(
      'PROJECT_SPACE_PREVIEW_STATUS_ROOT: /workspace/deploy-state/project-space-preview'
    );
    expect(compose).toContain('/opt/platform/state:/workspace/deploy-state:ro');
  });

  test('passes only the named GitHub token-encryption secret into the web runtime', async () => {
    const compose = await readFile(productionComposeFile, 'utf8');
    const web = /\n  web:\n([\s\S]*?)\n  tailscale-status:\n/.exec(compose)?.[1] ?? '';
    const sidecar = /\n  tailscale-status:\n([\s\S]*?)\n  docs:\n/.exec(compose)?.[1] ?? '';

    expect(web).toContain(
      'PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: ${PROJECT_SPACE_TOKEN_ENCRYPTION_KEY:-}'
    );
    expect(sidecar).not.toContain('PROJECT_SPACE_TOKEN_ENCRYPTION_KEY');
  });

  test('isolates the host Tailscale socket behind a minimal fixed-operation sidecar', async () => {
    const dockerfile = await readFile(productionWebDockerfile, 'utf8');
    const compose = await readFile(productionComposeFile, 'utf8');
    const web = /\n  web:\n([\s\S]*?)\n  tailscale-status:\n/.exec(compose)?.[1] ?? '';
    const sidecar = /\n  tailscale-status:\n([\s\S]*?)\n  docs:\n/.exec(compose)?.[1] ?? '';
    const ownerSubjectHash = /PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256:\s+\$\{PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256:-([a-f0-9]{64})\}/
      .exec(web)?.[1];

    expect(dockerfile).toContain('FROM scratch AS tailscale-status-runner');
    expect(dockerfile).toContain('USER 65534:65534');
    expect(web).not.toContain('tailscaled.sock');
    expect(ownerSubjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(web).toContain('PROJECT_DEPLOY_ENVIRONMENT: ${PROJECT_ENV:-prod}');
    expect(sidecar).toContain('target: tailscale-status-runner');
    expect(sidecar).toContain('read_only: true');
    expect(sidecar).toContain('no-new-privileges:true');
    expect(sidecar).toContain('/var/run/tailscale/tailscaled.sock:ro');
    expect(sidecar).not.toContain('CLERK_SECRET_KEY');
    expect(sidecar).not.toContain('GITHUB_TOKEN');
  });

  test('supports host-independent OAuth inventory without starting the legacy sidecar', async () => {
    const overlay = await readFile(tailscaleOAuthComposeFile, 'utf8');
    expect(overlay).toContain('tailscale-status:');
    expect(overlay).toContain('legacy-vps-local-tailscale');
    expect(overlay).not.toContain('tailscaled.sock');
    expect(overlay).not.toContain('/var/run/tailscale');
  });

  test('loads deployment-owned Tailscale OAuth credentials from the fixed Infisical project', async () => {
    const deployment = await readFile(deploymentConfigFile, 'utf8');
    for (const name of [
      'PROJECT_SPACE_ALLOWED_EMAILS',
      'TAILSCALE_OAUTH_CLIENT_ID',
      'TAILSCALE_OAUTH_CLIENT_SECRET'
    ]) {
      expect(deployment).toContain(
        `${name}: infisical://467bbc88-262a-4ea0-a238-9666d6e7e359/prod/${name}`
      );
    }
    expect(deployment).not.toContain('PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY');
    expect(deployment).not.toContain('op://');
  });

  test('passes deployment-owned Tailscale credentials to the web runtime only', async () => {
    const compose = await readFile(productionComposeFile, 'utf8');
    const web = /\n  web:\n([\s\S]*?)\n  tailscale-status:\n/.exec(compose)?.[1] ?? '';
    expect(web).toContain('TAILSCALE_OAUTH_CLIENT_ID: ${TAILSCALE_OAUTH_CLIENT_ID:-}');
    expect(web).toContain('TAILSCALE_OAUTH_CLIENT_SECRET: ${TAILSCALE_OAUTH_CLIENT_SECRET:-}');
    expect(web).not.toContain('PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY');
  });

  test('configures the SSH control gateway identity on each Project Space web service', async () => {
    const production = await readFile(productionComposeFile, 'utf8');
    const preview = await readFile(previewComposeFile, 'utf8');
    expect(production).toContain(
      'PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID: ${PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID:-project-space-prod-web}'
    );
    const previewWeb = /\n  web:\n([\s\S]*?)\n  docs:\n/.exec(preview)?.[1] ?? '';
    expect(previewWeb).toContain(
      'PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID: ${PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID:-project-space-preview-web}'
    );
  });
});
