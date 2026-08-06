import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preflightPlan } from '../scripts/ci-preflight';
import {
  fastCiSelection,
  releaseVerificationPolicy,
  releaseWorkflowTriggered,
} from '../scripts/release-verification-policy';

const fixture = {
  baseVersion: '0.4.55',
  eventName: 'pull_request',
  headVersion: '0.4.55',
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('canonical local CI preflight', () => {
  test.each([
    ['ordinary web change', ['src/features/project-desktop/example.tsx'], false],
    ['release-critical', ['packaging/release/example.ts'], true],
    ['platform workflow', ['.github/workflows/release.yml'], true],
    ['docs', ['apps/docs/content/docs/index.mdx'], false],
    ['Go', ['cmd/project/main.go'], false],
    ['web', ['src/main.tsx'], false],
    ['mobile', ['apps/mobile/App.tsx'], false],
  ])('classifies representative %s fixture conservatively', (_name, changedPaths, full) => {
    expect(
      releaseVerificationPolicy({ ...fixture, changedPaths }).fullMatrix,
    ).toBe(full);
  });

  test.each([
    ['ordinary web change', ['src/features/project-desktop/example.tsx'], ['web-build'], ['cli-docs-contract', 'docs-build', 'mobile-build', 'go-race', 'actionlint']],
    ['release-critical', ['packaging/release/example.ts'], ['go-race', 'actionlint'], []],
    ['platform workflow', ['.github/workflows/release.yml'], ['go-race', 'actionlint'], []],
    ['docs', ['apps/docs/content/docs/index.mdx'], ['docs-build'], ['cli-docs-contract', 'go-race']],
    ['Go', ['cmd/project/main.go'], ['cli-docs-contract', 'go-race'], ['actionlint']],
    ['web', ['src/main.tsx'], ['web-build'], ['cli-docs-contract', 'go-race']],
    ['mobile', ['apps/mobile/App.tsx'], ['mobile-build'], ['cli-docs-contract', 'go-race']],
  ])('selects the required local lanes for representative %s changes', (_name, changedPaths, present, absent) => {
    const policy = releaseVerificationPolicy({ ...fixture, changedPaths });
    const ids = preflightPlan({
      changedPaths,
      fullMatrix: policy.fullMatrix,
      host: 'linux',
      version: fixture.headVersion,
    }).map(({ id }) => id);
    for (const id of present) expect(ids).toContain(id);
    for (const id of absent) expect(ids).not.toContain(id);
  });

  test('uses one shared fail-closed path selection policy', () => {
    expect(fastCiSelection(['src/main.tsx'], false)).toEqual({
      cliDocs: false,
      docs: false,
      go: false,
      mobile: false,
      workflow: false,
    });
    expect(fastCiSelection([], false)).toEqual({
      cliDocs: true,
      docs: true,
      go: true,
      mobile: true,
      workflow: true,
    });
  });

  test('selects all locally required unconditional PR lanes and records remote gates', () => {
    const plan = preflightPlan({
      changedPaths: ['package.json', '.github/workflows/docs.yml'],
      fullMatrix: true,
      host: 'darwin',
      pullRequest: 435,
      version: '0.4.56',
    });
    const ids = plan.map(({ id }) => id);

    expect(ids).toEqual(expect.arrayContaining([
      'release-entry',
      'package-manager-policy',
      'generated-cli-docs',
      'cli-docs-contract',
      'docs-typecheck',
      'docs-build',
      'tests',
      'web-build',
      'mobile-build',
      'go-race',
      'go-vet',
      'actionlint',
      'shell-syntax',
      'macos-packaging',
      'post-run-cleanliness',
    ]));
    expect(plan.filter(({ remoteOnly }) => remoteOnly).map(({ id }) => id)).toEqual([
      'linux-release-artifact',
      'windows-release-artifact',
      'signing-and-publication',
      'preview-and-production',
    ]);
  });

  test.each([
    '.github/actions/release-quality/action.yml',
    'internal/approvalsigner/signer.go',
    'scripts/release-verification-policy.ts',
    'cmd/project/example_windows.go',
  ])('keeps classifier-critical path %s reachable from Release', (path) => {
    expect(releaseWorkflowTriggered([path])).toBe(true);
  });

  test('documents the exact report and dirty-worktree contract', () => {
    const source = readFileSync('scripts/ci-preflight.ts', 'utf8');
    expect(source).toContain('schemaVersion: 1');
    expect(source).toContain('requires a clean worktree');
    expect(source).toContain("status: 'remote-only'");
    expect(source).toContain("'--pull-request'");
    expect(source).toContain('is not the checked-out HEAD');
    expect(source).toContain('RELEASE_BASE_SHA: baseSha');
    expect(source).toContain("conclusion: 'refused'");
    expect(source).toContain('generated files or edits remain after local lanes');
  });

  test('refuses a report for a revision other than the clean checkout in JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-ci-preflight-'));
    temporaryRoots.push(root);
    runGit(root, ['init', '-b', 'main']);
    runGit(root, ['config', 'user.email', 'test@example.com']);
    runGit(root, ['config', 'user.name', 'Preflight test']);
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n');
    runGit(root, ['add', 'package.json']);
    runGit(root, ['commit', '-m', 'base']);
    const base = runGit(root, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'marker.txt'), 'current checkout\n');
    runGit(root, ['add', 'marker.txt']);
    runGit(root, ['commit', '-m', 'head']);

    const child = Bun.spawnSync(
      [
        'bun',
        resolve(import.meta.dir, '../scripts/ci-preflight.ts'),
        '--base',
        base,
        '--head',
        base,
        '--format',
        'json',
      ],
      { cwd: root, stderr: 'pipe', stdout: 'pipe' },
    );
    const report = JSON.parse(child.stdout.toString()) as {
      conclusion: string;
      errors: string[];
    };
    expect(child.exitCode).toBe(2);
    expect(report.conclusion).toBe('refused');
    expect(report.errors.join('\n')).toContain('is not the checked-out HEAD');
  });
});

function runGit(root: string, args: string[]) {
  const child = Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe', stdout: 'pipe' });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString();
}
