import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  behaviorSensitivePaths,
  changedChangeArtifacts,
  validateRepository,
  validateRequirementDocument,
  validateTasks,
} from '../scripts/docs-specs/validator';
import { validateInternalDocsLinks } from '../scripts/docs-specs/links';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('documentation change-spec validation', () => {
  test('validates the checked-in current requirements, templates, and completed changes', () => {
    const report = validateRepository();

    expect(report.diagnostics).toEqual([]);
    expect(report.requirements).toBe(5);
    expect(report.changes).toBe(12);
    expect(report.templates).toBe(1);
  });

  test('requires normative behavior and complete Given/When/Then scenarios', () => {
    const source = `
## ADDED Requirements

### EXAMPLE-001 — Missing contract

The system provides something.

#### Scenario: Incomplete scenario

- **Given** a precondition
- **When** an action occurs
`;

    const result = validateRequirementDocument(source, 'requirements.mdx', true);

    expect(result.diagnostics.map((item) => item.message)).toEqual([
      'Requirement EXAMPLE-001 must contain normative MUST language.',
      '#### Scenario: Incomplete scenario for EXAMPLE-001 is missing a Then step.',
    ]);
  });

  test('rejects a completed leaf without evidence', () => {
    const diagnostics = validateTasks(`
## 1. Work

- [x] 1.1 Implement behavior
`, 'tasks.mdx', false);

    expect(diagnostics.map((item) => item.message)).toEqual([
      'Completed leaf task "1.1 Implement behavior" needs Evidence.',
    ]);
  });

  test('rejects a completed parent that hides an incomplete subtask', () => {
    const diagnostics = validateTasks(`
## 1. Work

- [x] 1.1 Implement behavior
  - [ ] Add the missing edge case
`, 'tasks.mdx', false);

    expect(diagnostics.map((item) => item.message)).toEqual([
      'Completed parent task "1.1 Implement behavior" contains an incomplete descendant.',
    ]);
  });

  test('accepts a blocked subtask with an explicit prerequisite and return condition', () => {
    const diagnostics = validateTasks(`
## 2. Device assignment

- [ ] 2.1 Migrate devices
  - [ ] Implement the backfill
    - **Status:** Blocked
    - **Reason:** Provider records lack account identity.
    - **Blocked by:** #812
    - **Unblocked when:** Provider records expose stable account identity.
    - **Continue in:** #813
`, 'tasks.mdx', false);

    expect(diagnostics).toEqual([]);
  });

  test('requires complete blocker metadata', () => {
    const diagnostics = validateTasks(`
## 2. Device assignment

- [ ] 2.1 Implement the backfill
  - **Status:** Blocked
`, 'tasks.mdx', false);

    expect(diagnostics.map((item) => item.message)).toEqual([
      'Blocked task "2.1 Implement the backfill" needs Reason.',
      'Blocked task "2.1 Implement the backfill" needs Blocked by.',
      'Blocked task "2.1 Implement the backfill" needs Unblocked when.',
    ]);
  });

  test('requires a concrete issue and copied acceptance criteria for deferred work', () => {
    const diagnostics = validateTasks(`
## 3. Deferred follow-ups

- [ ] Repair historical assignments
  - **Reason:** Outside the current scope.
`, 'tasks.mdx', false);

    expect(diagnostics.map((item) => item.message)).toEqual([
      'Deferred task "Repair historical assignments" needs Issue.',
      'Deferred task "Repair historical assignments" needs Acceptance criteria.',
    ]);
  });

  test('keeps required open work out of a completed change', () => {
    const diagnostics = validateTasks(`
## 1. Work

- [ ] 1.1 Implement required behavior

## 2. Deferred follow-ups

- [ ] Optional repair tool
  - **Issue:** #900
  - **Reason:** Explicitly removed from the current requirement.
  - **Acceptance criteria:** Copied to #900.
`, 'tasks.mdx', true);

    expect(diagnostics.map((item) => item.message)).toEqual([
      'Completed change still has required open task "1.1 Implement required behavior".',
    ]);
  });

  test('requires a changed change artifact when product or operational code changes', () => {
    const paths = [
      'src/features/example.ts',
      'tests/example.test.ts',
      'apps/docs/content/docs/product/example.mdx',
    ];

    expect(behaviorSensitivePaths(paths)).toEqual(['src/features/example.ts']);
    expect(changedChangeArtifacts(paths)).toEqual([]);
    expect(changedChangeArtifacts([
      ...paths,
      'apps/docs/content/docs/development/changes/example/tasks.mdx',
    ])).toEqual([
      'apps/docs/content/docs/development/changes/example/tasks.mdx',
    ]);
  });

  test('checks pull-request change-spec coverage from the merge base through the staged index', () => {
    const root = documentationRepository();
    const base = runGit(root, ['rev-parse', 'HEAD']).trim();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/example.ts'), 'export const example = true;\n');
    runGit(root, ['add', 'src/example.ts']);

    const uncovered = runStagedValidator(root, base);
    expect(uncovered.exitCode).toBe(1);
    expect(uncovered.stderr.toString()).toContain('no change-spec artifact changed');

    runGit(root, ['restore', '--staged', 'src/example.ts']);
    const tasks = join(
      root,
      'apps/docs/content/docs/development/changes/documentation-system/tasks.mdx',
    );
    writeFileSync(tasks, `${readFileSync(tasks, 'utf8')}\n<!-- coverage fixture -->\n`);
    runGit(root, ['add', tasks]);
    runGit(root, ['commit', '-m', 'document behavior change']);
    runGit(root, ['add', 'src/example.ts']);

    expect(runStagedValidator(root, base).exitCode).toBe(0);
  });

  test('validates staged documentation rather than an unstaged repair', () => {
    const root = documentationRepository();
    const base = runGit(root, ['rev-parse', 'HEAD']).trim();
    const proposal = join(
      root,
      'apps/docs/content/docs/development/changes/documentation-system/proposal.mdx',
    );
    const valid = readFileSync(proposal, 'utf8');
    writeFileSync(proposal, valid.replace('## Summary', '## Missing summary'));
    runGit(root, ['add', proposal]);
    writeFileSync(proposal, valid);

    const result = runStagedValidator(root, base);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('Proposal is missing the Summary section.');
  });

  test('rejects internal documentation links to missing deployed routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-doc-links-'));
    temporaryRoots.push(root);
    const docsRoot = join(root, 'apps/docs/content/docs');
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, 'index.mdx'), '[Missing](/docs/not-here)\n');

    expect(validateInternalDocsLinks(docsRoot, root)).toEqual([{
      line: 1,
      message: 'Internal docs link points to missing route /docs/not-here.',
      path: 'apps/docs/content/docs/index.mdx',
    }]);
  });
});

function documentationRepository() {
  const root = mkdtempSync(join(tmpdir(), 'project-space-staged-docs-test-'));
  temporaryRoots.push(root);
  cpSync('apps/docs/content/docs', join(root, 'apps/docs/content/docs'), {
    recursive: true,
  });
  cpSync('apps/docs/content/change-template', join(root, 'apps/docs/content/change-template'), {
    recursive: true,
  });
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Documentation test']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'base']);
  return root;
}

function runStagedValidator(root: string, base: string) {
  return Bun.spawnSync(
    [
      'bun',
      join(import.meta.dir, '../scripts/validate-docs-specs.ts'),
      '--staged',
      '--base',
      base,
    ],
    { cwd: root, stderr: 'pipe', stdout: 'pipe' },
  );
}

function runGit(root: string, arguments_: string[]) {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
