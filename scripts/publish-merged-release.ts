#!/usr/bin/env bun

import { appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import { compareStableSemver } from '../apps/docs/lib/releases/semver';
import {
  releaseIdentityPaths,
  validateReleaseIdentityBundle,
} from './release-identity';
import {
  exactProductionRuns,
  releaseRecoveryDecision,
  workflowRecoveryDecision,
  type HandoffRun,
} from './release-handoff-state';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entriesPath = 'apps/docs/content/docs/releases/entries';
const repository = process.env.GITHUB_REPOSITORY?.trim() || 'DotNaos/project-space';
const head = requiredCommit(process.env.RELEASE_AFTER_SHA, 'RELEASE_AFTER_SHA');
const eventName = requiredEventName(process.env.RELEASE_EVENT_NAME);
const dryRun = process.env.RELEASE_DRY_RUN === 'true';

interface ReleaseCandidate {
  commit: string;
  path: string;
  pullRequest: number;
  tag: string;
  version: string;
}

try {
  process.chdir(repositoryRoot);
  const exactResult = await validateMergedCommit(head);
  const candidates = releaseCandidates(head);
  const exactCandidates = candidates.filter(
    (candidate) => candidate.commit === head,
  );
  if (
    eventName === 'push' && exactResult.mode === 'release' &&
    exactCandidates.length !== 1
  ) {
    throw new Error(
      `Release merge ${head} must own exactly one durable release entry.`,
    );
  }
  const inspected = await Promise.all(candidates.map(inspectCandidate));
  const latestPublished = inspected
    .filter((item) => item.releaseState === 'published')
    .map((item) => item.candidate.version)
    .sort(compareStableSemver)
    .at(-1);
  const pending = inspected.filter((item) => {
    if (item.releaseState === 'published') return false;
    if (
      latestPublished &&
      compareStableSemver(item.candidate.version, latestPublished) <= 0
    ) {
      console.log(
        `Ignoring superseded unpublished ${item.candidate.tag}; ${latestPublished} is already published.`,
      );
      return false;
    }
    return true;
  });

  const oldestPending = pending.at(0);
  if (oldestPending) {
    await validateCandidate(oldestPending.candidate);
    await reconcileCandidate(oldestPending);
  }

  writeOutput('ordinary_deploy_required', 'false');
  if (pending.length > 0) {
    console.log(
      `Production waits for the oldest pending release ${oldestPending?.candidate.tag}.`,
    );
  } else if (exactResult.mode === 'ordinary') {
    await reconcileProductionDeploy();
  } else if (eventName !== 'push') {
    const tag = `v${exactResult.entry.version}`;
    const release = await githubRelease(tag);
    const releaseRuns = await workflowRuns('release.yml', head, tag);
    const releaseActive = releaseRuns.some((run) => run.status !== 'completed');
    if (release?.state === 'published' && !releaseActive) {
      await reconcileProductionDeploy();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function releaseCandidates(ref: string): ReleaseCandidate[] {
  const paths = gitOutput([
    'ls-tree', '-r', '--name-only', ref, '--', entriesPath,
  ]).split('\n').filter((path) => path.endsWith('.mdx'));
  const candidates = paths.map((path) => {
    const parsed = parseReleaseEntryMdx(
      gitOutput(['show', `${ref}:${path}`], false),
      basename(path),
    );
    if (!parsed.ok) fail(parsed.errors);
    const commits = gitOutput([
      'log', '--first-parent', '--diff-filter=A', '--format=%H', ref, '--', path,
    ]).split('\n').filter(Boolean);
    if (commits.length !== 1) {
      throw new Error(
        `${path} must have exactly one addition commit on main; found ${commits.length}.`,
      );
    }
    return {
      commit: requiredCommit(commits[0], `${path} addition commit`),
      path,
      pullRequest: parsed.entry.pullRequest,
      tag: `v${parsed.entry.version}`,
      version: parsed.entry.version,
    };
  });
  return candidates.sort((left, right) =>
    compareStableSemver(left.version, right.version));
}

async function inspectCandidate(candidate: ReleaseCandidate) {
  const [tagCommit, release] = await Promise.all([
    githubTagCommit(candidate.tag),
    githubRelease(candidate.tag),
  ]);
  if (tagCommit && tagCommit !== candidate.commit) {
    throw new Error(
      `Tag ${candidate.tag} identifies ${tagCommit}, not its main addition commit ${candidate.commit}.`,
    );
  }
  if (release?.state === 'published' && tagCommit !== candidate.commit) {
    throw new Error(
      `Published GitHub Release ${candidate.tag} is not fenced to ${candidate.commit}.`,
    );
  }
  return {
    candidate,
    releaseState: release?.state ?? 'missing' as 'draft' | 'missing' | 'published',
    tagCommit,
  };
}

async function validateCandidate(candidate: ReleaseCandidate) {
  const result = await validateMergedCommit(candidate.commit);
  if (
    result.mode !== 'release' ||
    result.entry.version !== candidate.version ||
    result.entry.pullRequest !== candidate.pullRequest
  ) {
    throw new Error(
      `${candidate.path} does not prove ${candidate.tag} at ${candidate.commit}.`,
    );
  }
}

async function validateMergedCommit(commit: string) {
  const parent = requiredCommit(
    gitOutput(['rev-parse', `${commit}^1`]),
    `${commit} first parent`,
  );
  const pullRequestNumber = await mergedPullRequestNumber(commit);
  const headPackageVersion = packageVersion(
    gitOutput(['show', `${commit}:package.json`], false),
    `${commit}:package.json`,
  );
  const result = validateReleasePullRequest({
    changedReleaseFiles: readChangedFiles(parent, commit),
    currentMainVersion: packageVersion(
      gitOutput(['show', `${parent}:package.json`], false),
      `${parent}:package.json`,
    ),
    existingGithubReleaseTags: new Set(),
    existingGitTags: new Set(),
    headEntries: readGitEntries(commit),
    headPackageVersion,
    mainEntries: readGitEntries(parent),
    pullRequestNumber,
  });
  if (!result.ok) fail(result.errors);
  const identityErrors = validateReleaseIdentityBundle(
    new Map(releaseIdentityPaths.map((path) => [
      path,
      gitOutput(['show', `${commit}:${path}`], false),
    ])),
    headPackageVersion,
  );
  if (identityErrors.length > 0) fail(identityErrors);
  return result;
}

async function reconcileCandidate(
  item: Awaited<ReturnType<typeof inspectCandidate>>,
) {
  const { candidate } = item;
  if (item.releaseState === 'draft') {
    throw new Error(
      `Draft GitHub Release ${candidate.tag} exists. Recover or remove that exact draft before retrying the handoff.`,
    );
  }
  if (eventName !== 'push' || candidate.commit !== head) {
    const publishers = await workflowRuns(
      'release-from-main.yml', candidate.commit, 'main', undefined, 'push',
    );
    const activePublisher = publishers.find((run) => run.status !== 'completed');
    if (activePublisher) {
      console.log(
        `Release handoff ${activePublisher.id} still owns ${candidate.tag}; recovery will wait.`,
      );
      return;
    }
  }
  if (!item.tagCommit) {
    await createTag(candidate.tag, candidate.commit);
    console.log(
      `${dryRun ? 'Would create' : 'Created'} ${candidate.tag} at ${candidate.commit}.`,
    );
  } else {
    console.log(`Reusing ${candidate.tag} at ${candidate.commit}.`);
  }

  const decision = releaseRecoveryDecision(
    'missing',
    await workflowRuns('release.yml', candidate.commit, candidate.tag),
  );
  if (decision.kind === 'wait') {
    console.log(
      `Release ${candidate.tag} is already ${decision.run.status} in run ${decision.run.id}.`,
    );
    return;
  }
  if (decision.kind === 'error' && decision.reason === 'success-without-result') {
    throw new Error(
      `A Release run succeeded for ${candidate.tag}, but no published release exists. Refusing a duplicate start.`,
    );
  }
  if (decision.kind === 'error') {
    throw new Error(
      `Release for ${candidate.tag} already used its automatic recovery attempt.`,
    );
  }
  if (decision.kind === 'rerun') {
    await mutateGithub(
      `/repos/${repository}/actions/runs/${decision.run.id}/rerun`,
      {},
    );
    console.log(
      `${dryRun ? 'Would rerun' : 'Rerunning'} failed release run ${decision.run.id} attempt ${decision.run.runAttempt} for ${candidate.tag}.`,
    );
    return;
  }
  await mutateGithub(
    `/repos/${repository}/actions/workflows/release.yml/dispatches`,
    { ref: candidate.tag },
  );
  console.log(
    `${dryRun ? 'Would dispatch' : 'Dispatched'} Release for ${candidate.tag}.`,
  );
}

async function reconcileProductionDeploy() {
  const currentMain = await githubBranchCommit('main');
  if (currentMain !== head) {
    console.log(
      `Ordinary merge ${head} is superseded by main ${currentMain}; Production stays untouched.`,
    );
    return;
  }
  const runs = exactProductionRuns(
    await workflowRuns('deploy-production.yml', head, 'main'),
    head,
  );
  const decision = workflowRecoveryDecision(runs);
  if (decision.kind === 'wait') {
    console.log(
      `Production already has exact-commit run ${decision.run.id} ${decision.run.status} for ${head}.`,
    );
    return;
  }
  if (decision.kind === 'complete') {
    console.log(`Production run ${decision.run.id} already succeeded for ${head}.`);
    return;
  }
  if (decision.kind === 'error') {
    throw new Error(
      `Production for ${head} already used its automatic recovery attempt.`,
    );
  }
  if (decision.kind === 'rerun') {
    await mutateGithub(
      `/repos/${repository}/actions/runs/${decision.run.id}/rerun`,
      {},
    );
    console.log(
      `${dryRun ? 'Would rerun' : 'Rerunning'} failed Production run ${decision.run.id} attempt ${decision.run.runAttempt} for ${head}.`,
    );
    return;
  }
  writeOutput('ordinary_deploy_required', 'true');
  console.log(
    `Ordinary merge ${head} is current main and requires one exact Production dispatch.`,
  );
}

async function mergedPullRequestNumber(commit: string) {
  const response = await githubFetch(`/repos/${repository}/commits/${commit}/pulls`);
  if (!response.ok) {
    throw new Error(`Could not identify the pull request merged as ${commit}.`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('GitHub returned invalid merged pull request data.');
  }
  const matches = body.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) && value.merged_at !== null &&
      isRecord(value.base) && value.base.ref === 'main' &&
      isRecord(value.base.repo) && value.base.repo.full_name === repository,
  );
  if (
    matches.length !== 1 || typeof matches[0].number !== 'number' ||
    !Number.isSafeInteger(matches[0].number)
  ) {
    throw new Error(
      `Merged commit ${commit} must belong to exactly one pull request targeting main.`,
    );
  }
  return matches[0].number;
}

async function githubRelease(tag: string) {
  const response = await githubFetch(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Could not revalidate GitHub Release ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.tag_name !== tag || typeof body.draft !== 'boolean') {
    throw new Error(`GitHub returned invalid publication data for ${tag}.`);
  }
  if (body.draft) return { state: 'draft' as const };
  if (typeof body.published_at !== 'string' || body.published_at.trim() === '') {
    throw new Error(
      `GitHub Release ${tag} is not a verifiably published release.`,
    );
  }
  return { state: 'published' as const };
}

async function githubTagCommit(tag: string) {
  const response = await githubFetch(`/repos/${repository}/git/ref/tags/${tag}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Could not verify existing tag ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.object) || typeof body.object.sha !== 'string') {
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
  if (!annotated.ok) throw new Error(`Could not resolve annotated tag ${tag}.`);
  const tagBody: unknown = await annotated.json();
  if (
    !isRecord(tagBody) || !isRecord(tagBody.object) ||
    tagBody.object.type !== 'commit' || typeof tagBody.object.sha !== 'string'
  ) {
    throw new Error(`${tag} does not resolve directly to a Git commit.`);
  }
  return requiredCommit(tagBody.object.sha, `${tag} target`);
}

async function githubBranchCommit(branch: string) {
  const response = await githubFetch(`/repos/${repository}/git/ref/heads/${branch}`);
  if (!response.ok) throw new Error(`Could not resolve protected branch ${branch}.`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) || !isRecord(body.object) || body.object.type !== 'commit' ||
    typeof body.object.sha !== 'string'
  ) {
    throw new Error(
      `GitHub returned an invalid target for protected branch ${branch}.`,
    );
  }
  return requiredCommit(body.object.sha, `${branch} target`);
}

async function workflowRuns(
  workflow: string,
  commit: string,
  branch: string,
  displayTitle?: string,
  event = 'workflow_dispatch',
) {
  const query = new URLSearchParams({
    event,
    head_sha: commit,
    per_page: '100',
  });
  const response = await githubFetch(
    `/repos/${repository}/actions/workflows/${workflow}/runs?${query}`,
  );
  if (!response.ok) {
    throw new Error(`Could not inspect ${workflow} runs for ${commit}.`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
    throw new Error(`GitHub returned invalid ${workflow} run data.`);
  }
  return body.workflow_runs.map(parseWorkflowRun).filter(
    (run) =>
      run.headSha === commit && run.headBranch === branch &&
      (!displayTitle || run.displayTitle === displayTitle),
  ).sort((left, right) => right.id - left.id);
}

function parseWorkflowRun(value: unknown): HandoffRun {
  if (
    !isRecord(value) || typeof value.id !== 'number' ||
    typeof value.head_sha !== 'string' || typeof value.head_branch !== 'string' ||
    typeof value.display_title !== 'string' ||
    typeof value.status !== 'string' || typeof value.run_attempt !== 'number' ||
    !(typeof value.conclusion === 'string' || value.conclusion === null)
  ) {
    throw new Error('GitHub returned an invalid workflow run.');
  }
  return {
    conclusion: value.conclusion,
    displayTitle: value.display_title,
    headBranch: value.head_branch,
    headSha: requiredCommit(value.head_sha, 'workflow run head'),
    id: value.id,
    runAttempt: value.run_attempt,
    status: value.status,
  };
}

async function createTag(tag: string, commit: string) {
  await mutateGithub(`/repos/${repository}/git/refs`, {
    ref: `refs/tags/${tag}`,
    sha: commit,
  });
}

async function mutateGithub(path: string, body: Record<string, unknown>) {
  if (dryRun) return;
  const response = await githubFetch(path, {
    body: JSON.stringify(body),
    method: 'POST',
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GitHub mutation ${path} failed (${response.status})${
        detail ? `: ${detail.slice(0, 300)}` : '.'
      }`,
    );
  }
}

function readChangedFiles(parent: string, commit: string): ChangedReleaseFile[] {
  const output = gitOutput([
    'diff', '--name-status', '--find-renames', parent, commit, '--', entriesPath,
  ]);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [rawStatus, firstPath, renamedPath] = line.split('\t');
    const path = renamedPath ?? firstPath;
    const status = rawStatus.startsWith('A') ? 'added'
      : rawStatus.startsWith('D') ? 'deleted'
        : rawStatus.startsWith('R') ? 'renamed' : 'modified';
    return {
      path,
      source: status === 'deleted'
        ? undefined
        : gitOutput(['show', `${commit}:${path}`], false),
      status,
    };
  });
}

function readGitEntries(ref: string) {
  const files = new Map<string, string>();
  const output = gitOutput([
    'ls-tree', '-r', '--name-only', ref, '--', entriesPath,
  ]);
  for (const path of output.split('\n').filter((path) => path.endsWith('.mdx'))) {
    files.set(basename(path), gitOutput(['show', `${ref}:${path}`], false));
  }
  return files;
}

function packageVersion(source: string, label: string) {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
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
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function requiredCommit(value: string | undefined, label: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return normalized;
}

function requiredEventName(value: string | undefined) {
  if (
    value === 'push' || value === 'schedule' || value === 'workflow_dispatch'
  ) return value;
  throw new Error(
    'RELEASE_EVENT_NAME must be push, schedule, or workflow_dispatch.',
  );
}

function writeOutput(key: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `${key}=${value}\n`, 'utf8');
}

function fail(errors: string[]): never {
  for (const error of errors) console.error(`- ${error}`);
  throw new Error(
    'Merged release validation failed closed; no tag or workflow was started.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
