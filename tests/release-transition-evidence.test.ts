import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('publishes sanitized evidence for every failed delivery workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/release-transition-evidence.yml',
    'utf8',
  );

  expect(workflow).toContain('workflow_run:');
  expect(workflow).toContain(
    'workflows: [Release, Deploy PR preview, Deploy production]',
  );
  expect(workflow).toContain(
    "github.event.workflow_run.conclusion != 'success'",
  );
  expect(workflow).toContain('actions: read');
  expect(workflow).toContain('error_code="${transition}_transition_failed"');
  expect(workflow).toContain('error_code="${transition}_superseded"');
  expect(workflow).toContain('failure_class=expected_deferred');
  expect(workflow).toContain('failure_class=flaky_test_signature');
  expect(workflow).toContain('failure_class=application_regression');
  expect(workflow).toContain('failure_class=infrastructure_failure');
  expect(workflow).toContain('select(.conclusion == "failure")');
  expect(workflow).toContain('any(. == "Resolve requested commit")');
  expect(workflow).toContain('error_code="${transition}_cancelled"');
  expect(workflow).toContain('"$SOURCE_EVENT" == pull_request');
  expect(workflow).toContain('failedJobs:');
  expect(workflow).toContain('delivery-transition.json');
  expect(workflow).toContain('path: delivery-transition.json');
  expect(workflow).not.toContain('/logs');
  expect(workflow).not.toContain('secrets.');
});
