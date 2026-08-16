import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentPackageManagerPolicyViolations,
  packageManagerPolicyViolations,
  stagedPackageManagerPolicyViolations,
} from '../scripts/check-package-manager';

const competingManager = ['p', 'npm'].join('');
const competingLock = `${competingManager}-lock.yaml`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Bun-only package-manager policy', () => {
  test('accepts the complete current repository policy', () => {
    expect(currentPackageManagerPolicyViolations()).toEqual([]);
  });

  test('rejects competing commands and lockfiles', () => {
    expect(packageManagerPolicyViolations(
      ['tooling.sh', 'nested.sh', 'bare.sh', 'operator.sh', competingLock],
      (path) => {
        if (path === 'tooling.sh') return `${competingManager} install`;
        if (path === 'nested.sh') return `(${['n', 'px'].join('')} tool)`;
        if (path === 'bare.sh') return competingManager;
        if (path === 'operator.sh') return `${competingManager}&&echo ok`;
        return '';
      }
    )).toEqual([
      'tooling.sh: competing package-manager command',
      'nested.sh: competing package-manager command',
      'bare.sh: competing package-manager command',
      'operator.sh: competing package-manager command',
      `${competingLock}: competing package-manager lock or workspace file`
    ]);
  });

  test('allows compatibility identifiers without invoking another manager', () => {
    expect(packageManagerPolicyViolations(
      ['package.json'],
      () => 'build_sha=${npm_package_version}'
    )).toEqual([]);
  });

  test('reads a staged violation even when the working tree contains a safe edit', () => {
    const root = packagePolicyRepository();
    writeFileSync(join(root, 'tooling.sh'), `${competingManager} install\n`);
    runGit(root, ['add', 'tooling.sh']);
    writeFileSync(join(root, 'tooling.sh'), 'bun install\n');

    expect(stagedPackageManagerPolicyViolations(root)).toContain(
      'tooling.sh: competing package-manager command',
    );
  });

  test('ignores an unstaged violation when the index remains safe', () => {
    const root = packagePolicyRepository();
    writeFileSync(join(root, 'tooling.sh'), `${competingManager} install\n`);

    expect(stagedPackageManagerPolicyViolations(root)).toEqual([]);
  });
});

function packagePolicyRepository() {
  const root = mkdtempSync(join(tmpdir(), 'project-space-package-policy-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'apps/docs'), { recursive: true });
  mkdirSync(join(root, 'apps/mobile'), { recursive: true });
  const manifest = JSON.stringify({ packageManager: 'bun@1.3.14' });
  writeFileSync(join(root, 'package.json'), manifest);
  writeFileSync(join(root, 'apps/mobile/package.json'), manifest);
  writeFileSync(join(root, 'bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(root, 'apps/docs/bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(root, 'apps/mobile/bun.lock'), 'lockfileVersion = 1\n');
  writeFileSync(join(root, 'tooling.sh'), 'bun install\n');
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Package policy test']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'base']);
  return root;
}

function runGit(root: string, arguments_: string[]) {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
