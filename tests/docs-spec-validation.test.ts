import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(report.changes).toBe(6);
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
