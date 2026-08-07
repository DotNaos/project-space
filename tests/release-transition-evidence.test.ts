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
    'contains(fromJSON(\'["failure","cancelled","timed_out","action_required","startup_failure"]\')',
  );
  expect(workflow).toContain('Preview\\ control*');
  expect(workflow).toContain('Production*');
  expect(workflow).toContain('SOURCE_RUN_ATTEMPT:');
  expect(workflow).toContain('runAttempt:$runAttempt');
  expect(workflow).toContain('github.event.workflow_run.run_attempt');
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
