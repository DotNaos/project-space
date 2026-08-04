#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';

const expectedBunVersion = '1.3.14';
const ignoredContentPaths = new Set([
  'apps/mobile/public/project-inventory.json',
  'apps/mobile/src/data/project-inventory.ts',
  'scripts/check-package-manager.ts',
  'tests/package-manager-policy.test.ts'
]);
const forbiddenFileNames = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml'
]);
const managerCommand = /(^|[\s"'`();&|])(?:npm|npx|pnpm)(?:@[^\s"'`();&|]+)?(?=$|[\s();&|])/m;

export function packageManagerPolicyViolations(
  paths: string[],
  readText: (path: string) => string | undefined
) {
  const violations: string[] = [];
  for (const path of paths) {
    const fileName = path.split('/').at(-1) ?? path;
    if (forbiddenFileNames.has(fileName)) {
      violations.push(`${path}: competing package-manager lock or workspace file`);
      continue;
    }
    if (ignoredContentPaths.has(path) || fileName === 'bun.lock') continue;
    const contents = readText(path);
    if (contents !== undefined && managerCommand.test(contents)) {
      violations.push(`${path}: competing package-manager command`);
    }
  }
  return violations;
}

function trackedAndUntrackedPaths() {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { stderr: 'pipe', stdout: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().split('\0').filter(Boolean);
}

function packageManager(path: string) {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { packageManager?: unknown };
  return parsed.packageManager;
}

export function currentPackageManagerPolicyViolations() {
  const paths = trackedAndUntrackedPaths().filter((path) => existsSync(path));
  const violations = packageManagerPolicyViolations(paths, (path) => {
    const contents = readFileSync(path);
    return contents.includes(0) ? undefined : contents.toString('utf8');
  });
  for (const path of ['bun.lock', 'apps/docs/bun.lock', 'apps/mobile/bun.lock']) {
    if (!existsSync(path)) violations.push(`${path}: required Bun lock is missing`);
  }
  for (const path of ['package.json', 'apps/mobile/package.json']) {
    if (packageManager(path) !== `bun@${expectedBunVersion}`) {
      violations.push(`${path}: packageManager must be bun@${expectedBunVersion}`);
    }
  }
  if (Bun.version !== expectedBunVersion) {
    violations.push(`runtime: Bun must be ${expectedBunVersion}, received ${Bun.version}`);
  }
  return violations;
}

if (import.meta.main) {
  const violations = currentPackageManagerPolicyViolations();
  if (violations.length > 0) {
    console.error(`Bun-only package-manager policy failed:\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log(`Bun-only package-manager policy passed for Bun ${expectedBunVersion}.`);
}
