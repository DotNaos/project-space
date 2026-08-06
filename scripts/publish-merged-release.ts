#!/usr/bin/env bun

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';
import {
  readReleaseIdentitySources,
  validateReleaseIdentityBundle,
} from './release-identity';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const entriesPath =
  'apps/docs/content/docs/releases/entries';
const repository =
  process.env.GITHUB_REPOSITORY?.trim() ||
  'DotNaos/project-space';
const before = requiredCommit(
  process.env.RELEASE_BEFORE_SHA,
  'RELEASE_BEFORE_SHA',
);
const after = requiredCommit(
  process.env.RELEASE_AFTER_SHA,
  'RELEASE_AFTER_SHA',
);

try {
  process.chdir(repositoryRoot);
  const pullRequestNumber = await mergedPullRequestNumber();
  const changedReleaseFiles = readChangedFiles();
  const currentMainVersion = packageVersion(
    gitOutput(['show', `${before}:package.json`]),
    `${before}:package.json`,
  );
  const headPackageVersion = packageVersion(
    readFileSync('package.json', 'utf8'),
    'package.json',
  );
  const result = validateReleasePullRequest({
    changedReleaseFiles,
    currentMainVersion,
    existingGithubReleaseTags: new Set(),
    existingGitTags: new Set(),
    headEntries: readWorkingTreeEntries(),
    headPackageVersion,
    mainEntries: readGitEntries(before),
    pullRequestNumber,
  });
  if (!result.ok) fail(result.errors);
  const identityErrors = validateReleaseIdentityBundle(
    readReleaseIdentitySources(),
    headPackageVersion,
  );
  if (identityErrors.length > 0) fail(identityErrors);
  if (result.mode === 'ordinary') {
    console.log(
      `Merged pull request #${pullRequestNumber} keeps version ${currentMainVersion}; no versioned release is required.`,
    );
    writeOutput('release_required', 'false');
    writeOutput('release_exists', 'false');
    process.exit(0);
  }

  const tag = `v${result.entry.version}`;
  const existingTagCommit = await githubTagCommit(tag);
  const existingRelease = await githubRelease(tag);
  if (existingRelease?.state === 'published') {
    if (existingTagCommit !== after) {
      throw new Error(
        `GitHub Release ${tag} exists but does not identify merged commit ${after}.`,
      );
    }
    console.log(
      `GitHub Release ${tag} already exists at ${after}; publication is complete.`,
    );
    writeOutput('tag', tag);
    writeOutput('release_required', 'true');
    writeOutput('release_exists', 'true');
    process.exit(0);
  }
  if (existingRelease?.state === 'draft') {
    throw new Error(
      `Draft GitHub Release ${tag} exists and is not published. Recover or rerun its exact release workflow before retrying this handoff.`,
    );
  }

  if (existingTagCommit && existingTagCommit !== after) {
    throw new Error(
      `Tag ${tag} already identifies ${existingTagCommit}, not merged commit ${after}.`,
    );
  }
  if (!existingTagCommit) {
    await createTag(tag);
    console.log(`Created ${tag} at merged commit ${after}.`);
  } else {
    console.log(`Reusing ${tag} at merged commit ${after}.`);
  }
  writeOutput('tag', tag);
  writeOutput('release_required', 'true');
  writeOutput('release_exists', 'false');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

async function mergedPullRequestNumber() {
  const response = await githubFetch(
    `/repos/${repository}/commits/${after}/pulls`,
  );
  if (!response.ok) {
    throw new Error(
      `Could not identify the pull request merged as ${after}.`,
    );
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('GitHub returned invalid merged pull request data.');
  }
  const matches = body.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) &&
      value.merged_at !== null &&
      isRecord(value.base) &&
      value.base.ref === 'main' &&
      isRecord(value.base.repo) &&
      value.base.repo.full_name === repository,
  );
  if (
    matches.length !== 1 ||
    typeof matches[0].number !== 'number' ||
    !Number.isSafeInteger(matches[0].number)
  ) {
    throw new Error(
      `Merged commit ${after} must belong to exactly one pull request targeting main.`,
    );
  }
  return matches[0].number;
}

async function githubRelease(tag: string) {
  const response = await githubFetch(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Could not revalidate GitHub Release ${tag}.`);
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    body.tag_name !== tag ||
    typeof body.draft !== 'boolean'
  ) {
    throw new Error(
      `GitHub returned invalid publication data for ${tag}.`,
    );
  }
  if (body.draft) return { state: 'draft' as const };
  if (
    typeof body.published_at !== 'string' ||
    body.published_at.trim() === ''
  ) {
    throw new Error(
      `GitHub Release ${tag} is not a verifiably published release.`,
    );
  }
  return {
    publishedAt: body.published_at,
    state: 'published' as const,
  };
}

async function githubTagCommit(tag: string) {
  const response = await githubFetch(
    `/repos/${repository}/git/ref/tags/${tag}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Could not verify existing tag ${tag}.`);
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !isRecord(body.object) ||
    typeof body.object.sha !== 'string'
  ) {
    throw new Error(`GitHub returned an invalid target for ${tag}.`);
  }
  if (body.object.type === 'commit') {
    return requiredCommit(body.object.sha, `${tag} target`);
  }
  if (body.object.type !== 'tag') {
    throw new Error(`${tag} does not resolve to a Git commit.`);
  }

  const annotated = await githubFetch(
    `/repos/${repository}/git/tags/${body.object.sha}`,
  );
  if (!annotated.ok) {
    throw new Error(`Could not resolve annotated tag ${tag}.`);
  }
  const tagBody: unknown = await annotated.json();
  if (
    !isRecord(tagBody) ||
    !isRecord(tagBody.object) ||
    tagBody.object.type !== 'commit' ||
    typeof tagBody.object.sha !== 'string'
  ) {
    throw new Error(`${tag} does not resolve directly to a Git commit.`);
  }
  return requiredCommit(tagBody.object.sha, `${tag} target`);
}

async function createTag(tag: string) {
  const response = await githubFetch(
    `/repos/${repository}/git/refs`,
    {
      body: JSON.stringify({
        ref: `refs/tags/${tag}`,
        sha: after,
      }),
      method: 'POST',
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Could not create ${tag} at ${after} (${response.status})${detail ? `: ${detail.slice(0, 300)}` : '.'}`,
    );
  }
}

function readChangedFiles(): ChangedReleaseFile[] {
  const output = gitOutput([
    'diff',
    '--name-status',
    '--find-renames',
    before,
    after,
    '--',
    entriesPath,
  ]);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [rawStatus, firstPath, renamedPath] = line.split('\t');
    const path = renamedPath ?? firstPath;
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
        status === 'deleted' || !existsSync(path)
          ? undefined
          : readFileSync(path, 'utf8'),
      status,
    };
  });
}

function readWorkingTreeEntries() {
  const files = new Map<string, string>();
  for (const entry of readdirSync(entriesPath, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;
    files.set(
      entry.name,
      readFileSync(join(entriesPath, entry.name), 'utf8'),
    );
  }
  return files;
}

function readGitEntries(ref: string) {
  const files = new Map<string, string>();
  const output = gitOutput([
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    '--',
    entriesPath,
  ]);
  for (const path of output
    .split('\n')
    .filter((path) => path.endsWith('.mdx'))) {
    files.set(
      basename(path),
      gitOutput(['show', `${ref}:${path}`], false),
    );
  }
  return files;
}

function packageVersion(source: string, label: string) {
  const parsed: unknown = JSON.parse(source);
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error(`${label} must declare a string version.`);
  }
  return parsed.version;
}

function githubFetch(path: string, init: RequestInit = {}) {
  const token = process.env.GH_TOKEN?.trim();
  if (!token) {
    throw new Error('GH_TOKEN is required for trusted release publication.');
  }
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'project-space-release-publisher',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
}

function gitOutput(args: string[], trim = true) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function requiredCommit(
  value: string | undefined,
  label: string,
) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return normalized;
}

function writeOutput(key: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${key}=${value}\n`, 'utf8');
}

function fail(errors: string[]): never {
  for (const error of errors) console.error(`- ${error}`);
  throw new Error(
    'Merged release validation failed closed; no tag was created.',
  );
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
