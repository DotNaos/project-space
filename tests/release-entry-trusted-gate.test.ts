import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('runs the release gate from trusted main against the exact PR commit as data', () => {
  const workflow = readFileSync(
    '.github/workflows/release-entry-gate.yml',
    'utf8',
  );
  const validator = readFileSync(
    'scripts/validate-release-pr.ts',
    'utf8',
  );

  expect(workflow).toContain('pull_request_target:');
  expect(workflow).toContain('push:\n    branches: [main]');
  expect(workflow).toContain(
    'ref: ${{ matrix.mainSha }}',
  );
  expect(workflow).toContain(
    'RELEASE_HEAD_SHA: ${{ matrix.headSha }}',
  );
  expect(workflow).toContain(
    'RELEASE_BASE_SHA: ${{ matrix.mainSha }}',
  );
  expect(workflow).toContain(
    '"pull/${PR_NUMBER}/head:${target_ref}"',
  );
  expect(workflow).not.toContain(
    'ref: ${{ github.event.pull_request.head.sha }}',
  );
  expect(workflow).toContain('checks: write');
  expect(workflow).toContain(
    "name 'Versioned release entry'",
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/check-runs"',
  );
  expect(workflow).toContain(
    '"repos/${GITHUB_REPOSITORY}/check-runs/${CHECK_ID}"',
  );
  expect(workflow).toContain(
    'pulls?state=open&base=main&per_page=100',
  );
  expect(workflow).toContain('select(.draft == false)');
  expect(workflow).toContain('if [[ "$PR_IS_DRAFT" == true ]]');
  expect(workflow).toContain(
    'external_id: $external_id',
  );
  expect(workflow).toContain(
    'select(.external_id == $key and .status == "completed")',
  );
  expect(workflow).toContain(
    '"$EVENT_NAME" == pull_request_target',
  );
  expect(workflow).not.toContain(
    '[[ "$conclusion" == success ]]',
  );
  expect(workflow).not.toContain('persist-credentials: true');
  expect(workflow).toContain(
    'bun install --frozen-lockfile --ignore-scripts',
  );
  expect(validator).toContain(
    "await gitText('show', `${headRef}:package.json`)",
  );
  expect(validator).toContain(
    "await gitText('show', `${baseRef}:package.json`)",
  );
  expect(validator).not.toContain(
    'release-entries.generated.json',
  );
});
