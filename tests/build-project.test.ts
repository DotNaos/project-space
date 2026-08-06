import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { shouldBuildMobilePrototype } from '../scripts/build-project';

const previewWebDockerfile = new URL(
  '../deploy/preview.web.Dockerfile',
  import.meta.url
);

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

  test('keeps server-side changelog modules in the Preview web runtime', async () => {
    const dockerfile = await readFile(previewWebDockerfile, 'utf8');

    expect(dockerfile).toContain(
      'COPY --from=build /workspace/apps/docs/lib/releases /workspace/apps/docs/lib/releases'
    );
    expect(dockerfile).toContain(
      'RUN bun -e "await import(\'./server/project-space-api-public-routes.ts\')"'
    );
  });
});
