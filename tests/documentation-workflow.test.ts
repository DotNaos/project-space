import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('folds path-selected documentation checks into one clear PR job', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  expect(workflow).toContain(
    'types: [opened, reopened, synchronize, ready_for_review, converted_to_draft]',
  );
  expect(workflow.match(/^  [a-z][a-z-]+:$/gm)).toEqual(['  fast-ci:']);
  expect(workflow).toContain('name: Fast CI');
  expect(workflow).toContain("if: steps.select.outputs.cliDocs == 'true'");
  expect(workflow).toContain("if: steps.select.outputs.docs == 'true'");
  expect(workflow).toContain('bun run docs:cli:check');
  expect(workflow).toContain('bun run typecheck');
  expect(workflow).toContain('bun run build');
  expect(workflow.match(/run: bun install --frozen-lockfile/g)).toHaveLength(1);
  expect(workflow).not.toContain('docs:release:pr');
  expect(workflow).not.toContain('release-entry');
});
