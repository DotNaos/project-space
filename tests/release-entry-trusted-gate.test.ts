import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('validates one exact current PR head from trusted latest main', () => {
  const workflow = readFileSync(
    '.github/workflows/release-entry-gate.yml',
    'utf8',
  );
  const validator = readFileSync(
    'scripts/validate-release-pr.ts',
    'utf8',
  );

  expect(workflow).toContain('pull_request_target:');
  expect(workflow).not.toContain('push:\n    branches: [main]');
  expect(workflow).not.toContain('workflow_dispatch:');
  expect(workflow).toContain(
    'group: release-decision-${{ github.event.pull_request.number }}',
  );
  expect(workflow).toContain('cancel-in-progress: true');
  expect(workflow.match(/^  [a-z][a-z-]+:$/gm)).toEqual(['  validate:']);
  expect(workflow).toContain('name: Release decision');
  expect(workflow).toContain(
    'ref: ${{ steps.target.outputs.main_sha }}',
  );
  expect(workflow).toContain(
    'RELEASE_HEAD_SHA: ${{ steps.target.outputs.head_sha }}',
  );
  expect(workflow).toContain(
    'RELEASE_BASE_SHA: ${{ steps.target.outputs.main_sha }}',
  );
  expect(workflow).toContain(
    '"pull/${PR_NUMBER}/head:${target_ref}"',
  );
  expect(workflow).not.toContain(
    'ref: ${{ github.event.pull_request.head.sha }}',
  );
  expect(workflow).not.toContain('checks: write');
  expect(workflow).not.toContain('check-runs');
  expect(workflow).not.toContain('external_id');
  expect(workflow).not.toContain('pulls?state=open&base=main&per_page=100');
  expect(workflow).not.toContain('strategy:');
  expect(workflow).not.toContain('matrix:');
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/pulls/${pr_number}"',
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
  );
  expect(workflow).toContain('[[ "$current_head" != "$requested_head" ]]');
  expect(workflow).not.toContain('continue-on-error: true');
  expect(workflow).not.toContain('action_required');
  expect(workflow).toContain('run: bun scripts/validate-release-pr.ts');
  expect(workflow).toContain('Revalidate exact pull request head and main');
  expect(workflow).toContain(
    '[[ "$(jq -er \'\.head.sha\' <<<"$pr")" == "$EXPECTED_HEAD_SHA" ]]',
  );
  expect(workflow).toContain(
    '[[ "$current_main" == "$EXPECTED_MAIN_SHA" ]]',
  );
  expect(workflow).not.toContain('persist-credentials: true');
  expect(workflow).toContain(
    'bun install --frozen-lockfile --ignore-scripts',
  );
  expect(validator).toContain(
    "await gitTextValidation('show', `${headRef}:package.json`)",
  );
  expect(validator).toContain(
    "await gitText('show', `${baseRef}:package.json`)",
  );
  expect(validator).not.toContain(
    'release-entries.generated.json',
  );
  expect(validator).toContain("'--name-status'");
  expect(validator).toContain('`${baseRef}...${headRef}`');
  expect(validator).not.toContain('findGitHubRelease');
  expect(validator).not.toContain('validateReleaseIdentityBundle');
  expect(validator).not.toContain('releaseIdentityPaths.map');
});
