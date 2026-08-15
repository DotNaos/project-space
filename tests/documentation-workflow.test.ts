import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('folds path-selected documentation checks into one clear PR job', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  expect(workflow.match(/^  [a-z][a-z-]+:$/gm)).toEqual([
    '  fast-ci:',
    '  windows-cli:',
    '  preview-artifacts:',
  ]);
  expect(workflow).toContain('needs: fast-ci');
  expect(workflow).toContain('name: Build exact-head Preview artifacts');
  expect(workflow).toContain('name: Fast CI');
  expect(workflow).toContain('name: Windows CLI compatibility');
  expect(workflow).toContain("if: needs.fast-ci.outputs.go == 'true'");
  expect(workflow).toContain(
    "go test ./cmd/project -run '^TestWindows' -count=1",
  );
  expect(workflow).toContain(
    "go test ./internal/machineconnect ./internal/selfupdate -run '^$'",
  );
  expect(workflow).toContain(
    "run-name: 'CI · PR #${{ github.event.pull_request.number || inputs.pr || ''manual'' }}'",
  );
  expect(workflow).toContain('types: [opened, reopened, synchronize]');
  expect(workflow).not.toContain('converted_to_draft');
  expect(workflow).toContain('name: Fence an exact manual repair request');
  expect(workflow).toContain('[[ "$GITHUB_SHA" == "$REQUESTED_HEAD_SHA" ]]');
  expect(workflow).toContain('EVENT_NAME: pull_request');
  expect(workflow).toContain('name: Check package-manager policy');
  expect(workflow).toContain('name: Validate documentation and change specifications');
  expect(workflow).toContain('DOCS_SPECS_BASE: ${{ github.event.pull_request.base.sha || inputs.base_sha }}');
  expect(workflow).toContain('bun run docs:specs:check');
  expect(workflow).toContain('name: Run TypeScript tests');
  expect(workflow).toContain('name: Build web surfaces');
  expect(workflow).toContain("if: steps.select.outputs.cliDocs == 'true'");
  expect(workflow).toContain("if: steps.select.outputs.docs == 'true'");
  expect(workflow).toContain('bun run docs:cli:check');
  expect(workflow).toContain('bun run typecheck');
  expect(workflow).toContain('bun run build');
  expect(workflow.match(/run: bun install --frozen-lockfile/g)).toHaveLength(1);
  expect(workflow).not.toContain('docs:release:pr');
  expect(workflow).not.toContain('release-entry');
});
