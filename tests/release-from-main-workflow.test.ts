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
  const releaseWorkflow = readFileSync(
    '.github/workflows/release.yml',
    'utf8',
  );
  const releaseDeployWorkflow = readFileSync(
    '.github/workflows/release-deploy.yml',
    'utf8',
  );
  const releaseWorkflowFiles = [
    '.github/workflows/release.yml',
    '.github/workflows/release-manifest-sign.yml',
    '.github/workflows/release-macos.yml',
    '.github/workflows/release-publish.yml',
    '.github/workflows/release-trust-roots.yml',
  ].map((path) => readFileSync(path, 'utf8'));

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
  expect(releaseWorkflow.match(
    /github\.ref_type == 'tag' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/g,
  )).toHaveLength(5);
  expect(releaseWorkflow).toContain(
    'uses: ./.github/workflows/release-deploy.yml',
  );
  expect(releaseDeployWorkflow).toContain(
    'name: Start exact production delivery',
  );
  expect(releaseDeployWorkflow).toContain(
    'gh workflow run deploy-production.yml',
  );
  expect(releaseDeployWorkflow).toContain(
    '--repo "$GITHUB_REPOSITORY"',
  );
  expect(releaseDeployWorkflow).toContain(
    '-f commit="$RELEASE_COMMIT"',
  );
  expect(releaseDeployWorkflow).not.toContain('actions/checkout@');
  for (const source of releaseWorkflowFiles) {
    expect(source).not.toContain(
      "github.event_name == 'push' && github.ref_type == 'tag'",
    );
  }
  expect(publisher).toContain('validateReleasePullRequest');
  expect(publisher).toContain(
    'must belong to exactly one pull request targeting main',
  );
  expect(publisher).toContain('refs/tags/${tag}');
  expect(publisher).toContain(
    'Draft GitHub Release ${tag} exists and is not published',
  );
  expect(publisher).toContain(
    '/releases/tags/${encodeURIComponent(tag)}',
  );
  expect(publisher).not.toContain('releases?per_page=100');
  expect(publisher).not.toContain('git push');
});
