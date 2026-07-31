import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('publishes sanitized evidence for failed or superseded Release runs', () => {
  const workflow = readFileSync(
    '.github/workflows/release-transition-evidence.yml',
    'utf8',
  );

  expect(workflow).toContain('workflow_run:');
  expect(workflow).toContain('workflows: [Release]');
  expect(workflow).toContain(
    "github.event.workflow_run.conclusion != 'success'",
  );
  expect(workflow).toContain('actions: read');
  expect(workflow).toContain('release_transition_failed');
  expect(workflow).toContain('release_superseded');
  expect(workflow).toContain('failedJobs:');
  expect(workflow).toContain('release-transition.json');
  expect(workflow).not.toContain('/logs');
  expect(workflow).not.toContain('secrets.');
});
