import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('processes merged intents through one exact-tag release queue', () => {
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
  const releaseWorkflowFiles = [
    '.github/workflows/release.yml',
    '.github/workflows/release-manifest-sign.yml',
    '.github/workflows/release-macos.yml',
    '.github/workflows/release-publish.yml',
    '.github/workflows/release-trust-roots.yml',
  ].map((path) => readFileSync(path, 'utf8'));

  expect(workflow).toContain('branches: [main]');
  expect(workflow).toContain("cron: '17 * * * *'");
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain(
    'group: project-space-release-queue',
  );
  expect(workflow).toContain('Resolve current main queue head');
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha',
  );
  expect(workflow).toContain('ref: ${{ steps.main.outputs.sha }}');
  expect(workflow).toContain(
    'RELEASE_AFTER_SHA: ${{ steps.main.outputs.sha }}',
  );
  expect(workflow).toContain('RELEASE_EVENT_NAME: ${{ github.event_name }}');
  expect(workflow).not.toContain('github.event.before');
  expect(workflow).toContain(
    'bun scripts/publish-merged-release.ts',
  );
  expect(workflow).toContain(
    "if: steps.release.outputs.deploy_required == 'true'",
  );
  expect(workflow).toContain(
    'MERGED_COMMIT: ${{ steps.release.outputs.deploy_commit }}',
  );
  expect(workflow).toContain(
    'RELEASE_VERSION: ${{ steps.release.outputs.deploy_version }}',
  );
  expect(workflow).toContain('[[ "$MERGED_COMMIT" == "$QUEUE_HEAD" ]]');
  expect(workflow).toContain(
    '-f release_version="$RELEASE_VERSION"',
  );
  expect(releaseWorkflow.match(
    /github\.ref_type == 'tag' && github\.event_name == 'workflow_dispatch'/g,
  )).toHaveLength(5);
  expect(releaseWorkflow).not.toContain(
    'gh workflow run deploy-production.yml',
  );
  expect(releaseWorkflow).not.toContain('push:');
  expect(releaseWorkflow).not.toContain('pull_request:');
  expect(releaseWorkflow).toContain('cancel-in-progress: false');
  expect(releaseWorkflow).toContain(
    'group: project-space-release-publication',
  );
  expect(releaseWorkflow).toContain(
    'gh workflow run release-from-main.yml --repo "$GITHUB_REPOSITORY" --ref main',
  );
  for (const source of releaseWorkflowFiles) {
    expect(source).not.toContain(
      "github.event_name == 'push' && github.ref_type == 'tag'",
    );
  }
  expect(publisher).toContain('parseReleaseIntent');
  expect(publisher).toContain('releaseQueueDecision');
  expect(publisher).toContain('verifyConnectorRuntimeReleaseManifest');
  expect(publisher).toContain('latestPublishedRelease');
  expect(publisher).toContain('isFirstParentAncestor');
  expect(publisher).toContain("'rev-list', '--first-parent', '--reverse'");
  expect(publisher).toContain('releaseIntentEnforcementPath');
  expect(publisher).toContain('connectorReleaseSensitivePaths');
  expect(publisher).toContain('changes package version before queue assignment');
  expect(publisher).toContain('tagReservations');
  expect(publisher).toContain("'release.yml', decision.item.commit, decision.tag");
  expect(publisher).toContain('/rerun`');
  expect(publisher).toContain('/actions/workflows/release.yml/dispatches');
  expect(publisher).toContain('already used its automatic recovery attempt');
  expect(publisher).toContain("writeOutput('deploy_required'");
  expect(publisher).toContain("writeOutput('deploy_commit'");
  expect(publisher).toContain(
    'must belong to exactly one pull request targeting main',
  );
  expect(publisher).toContain('refs/tags/${tag}');
  expect(publisher).toContain(
    '/releases/tags/${encodeURIComponent(tag)}',
  );
  expect(publisher).not.toContain('releases?per_page=100');
  expect(publisher).not.toContain('git push');
  expect(publisher).not.toContain('RELEASE_BEFORE_SHA');
  expect(publisher).toContain(
    'await createTag(decision.tag, decision.item.commit)',
  );
});
