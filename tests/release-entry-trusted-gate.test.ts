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
  expect(workflow).toContain(
    'ref: ${{ github.event.pull_request.base.sha }}',
  );
  expect(workflow).toContain(
    'RELEASE_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
  );
  expect(workflow).toContain(
    '"pull/${PR_NUMBER}/head:${target_ref}"',
  );
  expect(workflow).not.toContain(
    'ref: ${{ github.event.pull_request.head.sha }}',
  );
  expect(workflow).not.toContain('persist-credentials: true');
  expect(workflow).toContain(
    'bun install --frozen-lockfile --ignore-scripts',
  );
  expect(validator).toContain(
    "await gitText('show', `${headRef}:package.json`)",
  );
  expect(validator).toContain(
    'await validateGeneratedChangelog(headRef, headEntrySources)',
  );
});
