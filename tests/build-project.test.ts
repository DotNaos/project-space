import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { shouldBuildMobilePrototype } from '../scripts/build-project';

const previewWebDockerfile = new URL(
  '../deploy/preview.web.Dockerfile',
  import.meta.url
);
const productionWebDockerfile = new URL('../deploy/Dockerfile', import.meta.url);
const productionComposeFile = new URL('../deploy/compose.yml', import.meta.url);
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
