#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseReleaseCatalog } from '../apps/docs/lib/releases/catalog';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';

const entryDirectory =
  'apps/docs/content/docs/releases/entries';
const repository =
  process.env.GITHUB_REPOSITORY || 'DotNaos/project-space';

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
  const headRef = releaseHeadRef();
  await run(['git', 'fetch', '--no-tags', 'origin', 'main']);
  await run(['git', 'fetch', '--tags', '--force', 'origin']);
  await run(['git', 'cat-file', '-e', `${headRef}^{commit}`]);

  const currentMainVersion = packageVersion(
    await gitText('show', 'origin/main:package.json'),
    'latest main package.json',
  );
  const headPackageVersion = packageVersion(
    await gitText('show', `${headRef}:package.json`),
    'PR package.json',
  );
  const changedReleasePaths = await parseNameStatus(
    await gitText(
      'diff',
      '--name-status',
      '--no-renames',
      `origin/main...${headRef}`,
      '--',
      entryDirectory,
    ),
    headRef,
  );
  const headEntrySources = await readGitEntries(headRef);
  const mainEntrySources = await readGitEntries('origin/main');
  const ownedSource = headEntrySources.get(`${pullRequest}.mdx`);
  const parsedOwned = ownedSource
    ? parseReleaseEntryMdx(
        ownedSource,
        `${pullRequest}.mdx`,
      )
    : undefined;
  const candidateTag = parsedOwned?.ok
    ? `v${parsedOwned.entry.version}`
    : undefined;
  const existingTags = candidateTag
    ? (await gitText('tag', '--list', candidateTag))
        .split('\n')
        .filter(Boolean)
    : [];
  const existingGitHubReleases = candidateTag
    ? await findGitHubRelease(candidateTag)
    : [];

  const result = validateReleasePullRequest({
    changedReleaseFiles: changedReleasePaths,
    currentMainVersion,
    existingGithubReleaseTags: new Set(existingGitHubReleases),
    existingGitTags: new Set(existingTags),
    headEntries: headEntrySources,
    headPackageVersion,
    mainEntries: mainEntrySources,
    pullRequestNumber: pullRequest,
  });
  if (!result.ok) {
    fail(result.errors);
  }

  console.log(
    `Release gate passed: PR #${pullRequest} owns ${result.entry.fileName}, version ${result.entry.version} (${result.entry.bump} from latest main ${currentMainVersion}).`,
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
        readFileSync(
          join(entryDirectory, fileName),
          'utf8',
        ),
      );
    }
  } catch {
    return entries;
  }
  return entries;
}

async function readGitEntries(ref: string) {
  const names = (
    await gitText(
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      entryDirectory,
    )
  )
    .split('\n')
    .filter((path) => path.endsWith('.mdx'));
  const entries = new Map<string, string>();
  for (const path of names) {
    entries.set(
      basename(path),
      await gitText('show', `${ref}:${path}`),
    );
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
          status === 'deleted'
            ? undefined
            : await gitText('show', `${headRef}:${path}`),
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

async function findGitHubRelease(tag: string) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        ...(process.env.GH_TOKEN
          ? { authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
        'user-agent': 'project-space-release-gate',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    fail(
      `GitHub Release uniqueness check failed with HTTP ${response.status}; the release gate fails closed.`,
    );
  }
  const body = await response.json();
  if (!isRecord(body) || body.tag_name !== tag) {
    fail(
      `GitHub Release uniqueness response for ${tag} was malformed; the release gate fails closed.`,
    );
  }
  return [tag];
}

async function gitText(...args: string[]) {
  return (await run(['git', ...args])).trim();
}

async function run(command: string[]) {
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
    fail(
      `Command ${command.join(' ')} failed: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

function fail(messages: string | string[]): never {
  const list = Array.isArray(messages) ? messages : [messages];
  console.error('Release documentation gate failed:');
  for (const message of list) console.error(`- ${message}`);
  process.exit(1);
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

await main();
