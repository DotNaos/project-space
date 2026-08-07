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
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('requested_head_sha:');
  expect(workflow).toContain('pr:');
  expect(workflow).toContain(
    "group: release-decision-${{ github.event.pull_request.number || inputs.pr }}",
  );
  expect(workflow).toContain('cancel-in-progress: true');
  expect(workflow.match(/^  [a-z][a-z-]+:$/gm)).toEqual(['  validate:']);
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
  expect(workflow).toContain('checks: write');
  expect(workflow).toContain(
    "name 'Release decision'",
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/check-runs"',
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/check-runs/${CHECK_ID}"',
  );
  expect(workflow).not.toContain('pulls?state=open&base=main&per_page=100');
  expect(workflow).not.toContain('strategy:');
  expect(workflow).not.toContain('matrix:');
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/pulls/${pr_number}"',
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
  );
  expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
  expect(workflow).toContain('[[ "$current_head" == "$requested_head" ]]');
  expect(workflow).toContain(
    'external_id: $external_id',
  );
  expect(workflow).toContain(
    '(.conclusion == "success" or .conclusion == "failure")',
  );
  expect(workflow).toContain('conclusion=action_required');
  expect(workflow).toContain(
    '"$VALIDATION_EXIT_CODE" != 1',
  );
  expect(workflow).toContain(
    'echo "exit_code=$exit_code" >> "$GITHUB_OUTPUT"',
  );
  expect(workflow).not.toContain(
    '[[ "$conclusion" == success ]]',
  );
  expect(workflow.match(/continue-on-error: true/g)?.length).toBe(5);
  expect(workflow).not.toContain('internal_failure');
  expect(workflow).toContain('conclusion=cancelled');
  expect(workflow).toContain('Validation was superseded before publication');
  expect(workflow).toContain(
    '(.status == "queued" or .status == "in_progress")',
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
  expect(validator).toContain('validateReleaseIdentityBundle');
  expect(validator).toContain('releaseIdentityPaths.map');
});
