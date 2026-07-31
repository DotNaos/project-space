import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('skips only the numbered release entry for drafts and rechecks when ready', () => {
  const workflow = readFileSync('.github/workflows/docs.yml', 'utf8');
  const releaseStep = workflow.slice(
    workflow.indexOf('      - name: Enforce one versioned release entry'),
    workflow.indexOf('      - name: Set up Go'),
  );
  const nonReleaseSteps = workflow.slice(workflow.indexOf('      - name: Set up Go'));

  expect(workflow).toContain(
    'types: [opened, reopened, synchronize, ready_for_review, converted_to_draft]',
  );
  expect(releaseStep).toContain("github.event.pull_request.draft == false");
  expect(nonReleaseSteps).not.toContain('github.event.pull_request.draft');
  expect(nonReleaseSteps).toContain('bun run docs:cli:check');
  expect(nonReleaseSteps).toContain('bun run docs:typecheck');
  expect(nonReleaseSteps).toContain('bun run docs:build');
});
