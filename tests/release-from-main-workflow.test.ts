import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('publishes a merged release only through the validated exact tag', () => {
  const workflow = readFileSync(
    '.github/workflows/release-from-main.yml',
    'utf8',
  );
  const publisher = readFileSync(
    'scripts/publish-merged-release.ts',
    'utf8',
  );

  expect(workflow).toContain('branches: [main]');
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain('RELEASE_AFTER_SHA: ${{ github.sha }}');
  expect(workflow).toContain(
    'RELEASE_BEFORE_SHA: ${{ github.event.before }}',
  );
  expect(workflow).toContain(
    'bun scripts/publish-merged-release.ts',
  );
  expect(workflow).toContain(
    'gh workflow run release.yml --ref "$RELEASE_TAG"',
  );
  expect(publisher).toContain('validateReleasePullRequest');
  expect(publisher).toContain(
    'must belong to exactly one pull request targeting main',
  );
  expect(publisher).toContain('refs/tags/${tag}');
  expect(publisher).not.toContain('git push');
});
