#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { prChangelogDirectory } from '../apps/docs/lib/changelog/pr-file';
import { parseReleaseCatalog } from '../apps/docs/lib/releases/catalog';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';

const entryDirectory =
  'apps/docs/content/docs/releases/entries';

async function main() {
  const [mode, value] = process.argv.slice(2);
  if (mode === '--catalog' && value === undefined) {
    validateHeadCatalog();
    return;
  }
  const requestedPullRequest =
    mode === '--pull-request' ? value : process.env.PR_NUMBER;
  if (
    (mode !== undefined && mode !== '--pull-request') ||
    !requestedPullRequest ||
    !/^[1-9]\d*$/.test(requestedPullRequest)
  ) {
    fail(
      'Usage: bun scripts/validate-release-pr.ts --pull-request <number> or --catalog',
    );
  }

  const pullRequest = Number(requestedPullRequest);
  const baseRef = releaseBaseRef();
  const headRef = releaseHeadRef();
  await run(['git', 'fetch', '--no-tags', 'origin', 'main']);
  await run(['git', 'cat-file', '-e', `${baseRef}^{commit}`]);
  await run(['git', 'cat-file', '-e', `${headRef}^{commit}`]);

  const basePackageVersion = packageVersion(
    await gitText('show', `${baseRef}:package.json`),
    'latest main package.json',
  );
  const headPackageVersion = packageVersion(
    await gitTextValidation('show', `${headRef}:package.json`),
    'PR package.json',
  );
  const changedFiles = await parseNameStatus(
    await gitText(
      'diff',
      '--name-status',
      '--no-renames',
      `${baseRef}...${headRef}`,
    ),
    headRef,
  );
  const result = validateReleasePullRequest({
    basePackageVersion,
    changedFiles,
    headPackageVersion,
    pullRequestNumber: pullRequest,
  });
  if (!result.ok) fail(result.errors);

  console.log(
    `Changelog gate passed: PR #${pullRequest} declares a ${result.bump} release and keeps concrete version ${basePackageVersion} unassigned.`,
  );
}

function validateHeadCatalog() {
  const packageJsonVersion = packageVersion(
    readFileSync('package.json', 'utf8'),
    'package.json',
  );
  const catalog = parseReleaseCatalog(readHeadEntries());
  if (!catalog.ok) fail(catalog.errors);
  const latest = catalog.catalog.entries[0];
  if (latest && latest.version !== packageJsonVersion) {
    fail(
      `Latest release entry ${latest.version} must match package.json version ${packageJsonVersion}.`,
    );
  }
  console.log(
    `Release catalog passed: ${catalog.catalog.entries.length} valid PR-owned entries; latest version ${latest?.version ?? 'none'}.`,
  );
}

function readHeadEntries() {
  const entries = new Map<string, string>();
  try {
    for (const fileName of readdirSync(entryDirectory)
      .filter((fileName) => fileName.endsWith('.mdx'))
      .sort()) {
      entries.set(
        basename(fileName),
        readFileSync(join(entryDirectory, fileName), 'utf8'),
      );
    }
  } catch {
    return entries;
  }
  return entries;
}

async function parseNameStatus(
  value: string,
  headRef: string,
): Promise<ChangedReleaseFile[]> {
  return Promise.all(
    value
      .split('\n')
      .filter(Boolean)
      .map(async (line) => {
        const [rawStatus, path = ''] = line.split('\t');
        const status = rawStatus.startsWith('A')
          ? 'added'
          : rawStatus.startsWith('D')
            ? 'deleted'
            : rawStatus.startsWith('R')
              ? 'renamed'
              : 'modified';
        return {
          path,
          source:
            status !== 'deleted' &&
              path.startsWith(`${prChangelogDirectory}/`)
              ? await gitTextValidationRaw('show', `${headRef}:${path}`)
              : undefined,
          status,
        };
      }),
  );
}

function releaseHeadRef() {
  const value = process.env.RELEASE_HEAD_SHA?.trim();
  if (value === undefined || value === '') return 'HEAD';
  if (!/^[0-9a-f]{40}$/.test(value)) {
    fail('RELEASE_HEAD_SHA must be a full lowercase Git commit SHA.');
  }
  return value;
}

function releaseBaseRef() {
  const value = process.env.RELEASE_BASE_SHA?.trim();
  if (value === undefined || value === '') return 'origin/main';
  if (!/^[0-9a-f]{40}$/.test(value)) {
    fail('RELEASE_BASE_SHA must be a full lowercase Git commit SHA.');
  }
  return value;
}

function packageVersion(source: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
  const version =
    isRecord(parsed) && typeof parsed.version === 'string'
      ? parsed.version
      : undefined;
  if (!version) fail(`${label} has no string version.`);
  return version;
}

async function gitText(...args: string[]) {
  return (await run(['git', ...args])).trim();
}

async function gitTextValidation(...args: string[]) {
  return (await run(['git', ...args], 'validation')).trim();
}

async function gitTextValidationRaw(...args: string[]) {
  return run(['git', ...args], 'validation');
}

async function run(
  command: string[],
  failureKind: 'infrastructure' | 'validation' = 'infrastructure',
) {
  const process = Bun.spawn(command, {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    const message =
      `Command ${command.join(' ')} failed: ${stderr.trim() || stdout.trim()}`;
    if (failureKind === 'validation') fail(message);
    failInfrastructure(message);
  }
  return stdout;
}

function fail(messages: string | string[]): never {
  const list = Array.isArray(messages) ? messages : [messages];
  console.error('Release documentation gate failed:');
  for (const message of list) console.error(`- ${message}`);
  process.exit(1);
}

function failInfrastructure(messages: string | string[]): never {
  const list = Array.isArray(messages) ? messages : [messages];
  console.error('Release documentation validator could not run:');
  for (const message of list) console.error(`- ${message}`);
  process.exit(2);
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

try {
  await main();
} catch (error) {
  failInfrastructure(
    error instanceof Error ? error.message : 'Unexpected validator failure.',
  );
}
