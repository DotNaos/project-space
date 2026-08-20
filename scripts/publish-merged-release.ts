#!/usr/bin/env bun

import { appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parsePrChangelog,
  prChangelogDirectory,
} from '../apps/docs/lib/changelog/pr-file';
import {
  parseReleaseIntent,
  releaseIntentDirectory,
  releaseIntentEnforcementPath,
  releaseIntentEnforcementSource,
  legacyReleaseIntentMigrationPath,
  type ReleaseIntent,
} from '../apps/docs/lib/releases/release-intent';
import { parseStableSemver } from '../apps/docs/lib/releases/semver';
import { verifyConnectorRuntimeReleaseManifest } from
  '../server/connector-runtime-release-manifest';
import {
  exactProductionRuns,
  exactReleaseRuns,
  releaseRecoveryDecision,
  workflowRecoveryDecision,
  type HandoffRun,
} from './release-handoff-state';
import {
  enforcedQueueCommits,
  releaseQueueDecision,
  type PublishedRelease,
  type QueuedMerge,
} from './release-queue-state';
import {
  activeReleaseTombstones,
  manifestIssuedAt,
  tagReservations,
} from './release-queue-evidence';
import { validateMergedIntentOnlyQueueItem } from './release-queue-validation';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseEntryDirectory = 'apps/docs/content/docs/releases/entries';
const repository = process.env.GITHUB_REPOSITORY?.trim() ||
  'DotNaos/project-space';
const head = requiredCommit(process.env.RELEASE_AFTER_SHA, 'RELEASE_AFTER_SHA');
requiredEventName(process.env.RELEASE_EVENT_NAME);
const dryRun = process.env.RELEASE_DRY_RUN === 'true';

try {
  process.chdir(repositoryRoot);
  const currentMain = await githubBranchCommit('main');
  if (currentMain !== head) {
    throw new Error(
      `Queue worker expected current main ${head}, but GitHub reports ${currentMain}.`,
    );
  }
  const published = await latestPublishedRelease();
  if (!isFirstParentAncestor(published.commit, head)) {
    throw new Error(
      `Latest signed release ${published.tag} at ${published.commit} is not on current main ${head}.`,
    );
  }
  const merges = await queuedMerges(published.commit, head);
  const reservations = tagReservations({
    currentMain: head,
    gitOutput,
    publishedVersion: published.version,
  });
  const tombstones = await activeReleaseTombstones({
    currentMain: head,
    githubFetch: (path) => githubFetch(`/repos/${repository}${path}`),
    gitOutput,
    published,
  });
  const decision = releaseQueueDecision({
    currentMain: head,
    merges,
    published,
    reservations,
    tombstones,
  });

  writeOutput('deploy_required', 'false');
  writeOutput('deploy_commit', head);
  writeOutput('deploy_version', published.version);
  writeOutput('deploy_release', published.tag);
  if (decision.kind === 'release') {
    await reconcileRelease(decision);
  } else {
    writeOutput('deploy_version', decision.release.version);
    writeOutput('deploy_release', decision.release.tag);
    await reconcileProductionDeploy(
      decision.commit,
      decision.release.version,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function latestPublishedRelease(): Promise<PublishedRelease> {
  const response = await githubFetch(`/repos/${repository}/releases/latest`);
  if (!response.ok) {
    throw new Error('A latest published GitHub Release is required to seed the queue.');
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) || body.draft !== false || body.prerelease !== false ||
    typeof body.tag_name !== 'string' ||
    typeof body.published_at !== 'string' || !Array.isArray(body.assets)
  ) {
    throw new Error('GitHub returned invalid latest release metadata.');
  }
  const version = body.tag_name.startsWith('v')
    ? body.tag_name.slice(1)
    : '';
  if (!parseStableSemver(version)) {
    throw new Error(`Latest release tag ${body.tag_name} is not stable SemVer.`);
  }
  const tag = `v${version}`;
  const commit = await githubTagCommit(tag);
  if (!commit) throw new Error(`Published release ${tag} has no Git tag.`);
  const manifestUrls = body.assets.flatMap((asset) =>
    isRecord(asset) && asset.name === 'project-space-release-manifest.json' &&
      typeof asset.browser_download_url === 'string'
      ? [asset.browser_download_url]
      : []
  );
  const expectedUrl =
    `https://github.com/${repository}/releases/download/${tag}/project-space-release-manifest.json`;
  if (manifestUrls.length !== 1 || manifestUrls[0] !== expectedUrl) {
    throw new Error(`Published release ${tag} has no unique canonical manifest.`);
  }
  const manifestResponse = await fetch(expectedUrl, {
    headers: {
      authorization: `Bearer ${requiredGithubToken()}`,
      'user-agent': 'project-space-release-queue',
    },
  });
  if (!manifestResponse.ok) {
    throw new Error(`Could not load signed manifest for ${tag}.`);
  }
  const source = await manifestResponse.text();
  if (!source || source.length > 2 * 1024 * 1024) {
    throw new Error(`Signed manifest for ${tag} has an invalid size.`);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(source);
  } catch {
    throw new Error(`Signed manifest for ${tag} is invalid JSON.`);
  }
  const issuedAt = manifestIssuedAt(envelope);
  const manifest = verifyConnectorRuntimeReleaseManifest(
    envelope,
    Buffer.from(
      gitOutput([
        'show',
        `${commit}:packaging/release/trust-roots/release-manifest-signing-public-key.pem`,
      ], false),
    ),
    { now: issuedAt },
  );
  if (
    manifest.releaseId !== tag || manifest.version !== version ||
    manifest.buildId !== commit
  ) {
    throw new Error(`Signed manifest for ${tag} does not match its exact tag.`);
  }
  return { commit, tag, version };
}

async function queuedMerges(
  publishedCommit: string,
  currentMain: string,
): Promise<QueuedMerge[]> {
  const commits = gitOutput([
    'rev-list', '--first-parent', '--reverse',
    `${publishedCommit}..${currentMain}`,
  ]).split('\n').filter(Boolean);
  const enforcementIndex = commits.findIndex((commit) =>
    addedPaths(commit, releaseIntentDirectory).includes(
      releaseIntentEnforcementPath,
    )
  );
  const alreadyEnforced = pathExistsAt(
    publishedCommit,
    releaseIntentEnforcementPath,
  ) && markerMatchesAt(publishedCommit);
  const enforcedCommits = enforcedQueueCommits({
    alreadyEnforced,
    commits,
    enforcementIndex,
  });

  const queued: QueuedMerge[] = [];
  for (const commit of enforcedCommits) {
    const parent = requiredCommit(
      gitOutput(['rev-parse', `${commit}^1`]),
      `${commit} first parent`,
    );
    const changedPaths = gitOutput([
      'diff', '--no-renames', '--name-only', parent, commit,
    ]).split('\n').filter(Boolean);
    if (changedPaths.includes(releaseIntentEnforcementPath)) {
      const isAdoptionCommit = !alreadyEnforced &&
        commit === commits[enforcementIndex] &&
        addedPaths(commit, releaseIntentDirectory).includes(
          releaseIntentEnforcementPath,
        ) && markerMatchesAt(commit);
      if (!isAdoptionCommit) {
        throw new Error(
          `Merged commit ${commit} changes the immutable release-intent enforcement marker.`,
        );
      }
    }
    const intentPaths = addedPaths(commit, releaseIntentDirectory)
      .filter((path) => path.endsWith('.json'));
    const changelogPaths = addedPaths(commit, prChangelogDirectory)
      .filter((path) => path.endsWith('.md'));
    if (intentPaths.length === 0 && changelogPaths.length === 0) {
      throw new Error(
        `Merged commit ${commit} must add exactly one changelog/<PR>.md file; no queue item was found.`,
      );
    }
    if (
      changedPaths.some((path) =>
        path.startsWith(`${releaseEntryDirectory}/`) && path.endsWith('.mdx')
      )
    ) {
      throw new Error(
        `Merged commit ${commit} changes legacy concrete release entries.`,
      );
    }
    const parentVersion = packageVersionAt(parent);
    if (packageVersionAt(commit) !== parentVersion) {
      throw new Error(
        `Merged commit ${commit} changes package version before queue assignment.`,
      );
    }
    const pullRequest = await mergedPullRequestNumber(commit);
    if (changelogPaths.length > 0) {
      if (changelogPaths.length !== 1) {
        throw new Error(
          `Merged commit ${commit} must add exactly one changelog/<PR>.md file; found ${changelogPaths.length}.`,
        );
      }
      const allChangelogChanges = changedPaths.filter((path) =>
        path.startsWith(`${prChangelogDirectory}/`),
      );
      if (allChangelogChanges.length !== 1) {
        throw new Error(
          `Merged commit ${commit} modifies changelog history instead of adding one queue item.`,
        );
      }
      const fileName = basename(changelogPaths[0]);
      const parsed = parsePrChangelog(
        gitOutput(['show', `${commit}:${changelogPaths[0]}`], false),
        fileName,
      );
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      if (parsed.changelog.pullRequest !== pullRequest) {
        throw new Error(
          `Merged commit ${commit} changelog ${changelogPaths[0]} belongs to PR #${parsed.changelog.pullRequest}, not merged PR #${pullRequest}.`,
        );
      }
      if (intentPaths.length > 0) {
        if (
          intentPaths.length !== 1 ||
          intentPaths[0] !== legacyReleaseIntentMigrationPath
        ) {
          throw new Error(
            `Merged commit ${commit} may carry at most one legacy release intent during changelog migration.`,
          );
        }
        const allIntentChanges = changedPaths.filter((path) =>
          path.startsWith(`${releaseIntentDirectory}/`) && path.endsWith('.json'),
        );
        if (allIntentChanges.length !== 1) {
          throw new Error(
            `Merged commit ${commit} modifies release-intent history instead of adding one migration compatibility item.`,
          );
        }
        const legacyIntent = readIntent(commit, intentPaths[0]);
        if (
          legacyIntent === 'none' ||
          legacyIntent !== parsed.changelog.bump
        ) {
          throw new Error(
            `Merged commit ${commit} legacy release intent must match changelog bump ${parsed.changelog.bump}.`,
          );
        }
      }
      queued.push({
        bump: parsed.changelog.bump,
        commit,
        pullRequest,
      });
      continue;
    }

    const allIntentChanges = changedPaths.filter((path) =>
      path.startsWith(`${releaseIntentDirectory}/`) && path.endsWith('.json'),
    );
    if (intentPaths.length !== 1 || allIntentChanges.length !== 1) {
      throw new Error(
        `Merged commit ${commit} modifies release-intent history instead of adding one queue item.`,
      );
    }
    const intent = readIntent(commit, intentPaths[0]);
    const productPaths = changedPaths.filter((path) =>
      path !== intentPaths[0] && path !== releaseIntentEnforcementPath,
    );
    validateMergedIntentOnlyQueueItem({
      allIntentChanges,
      intent,
      intentPaths,
      productPaths,
    });
    queued.push({ commit, intent, pullRequest });
  }
  return queued;
}

function addedPaths(commit: string, directory: string) {
  const parent = requiredCommit(
    gitOutput(['rev-parse', `${commit}^1`]),
    `${commit} first parent`,
  );
  const output = gitOutput([
    'diff', '--name-status', '--no-renames', parent, commit, '--', directory,
  ]);
  if (!output) return [];
  return output.split('\n').flatMap((line) => {
    const [status, path] = line.split('\t');
    return status === 'A' && path ? [path] : [];
  });
}

function readIntent(commit: string, path: string): ReleaseIntent {
  const parsed = parseReleaseIntent(
    gitOutput(['show', `${commit}:${path}`], false),
    basename(path),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.intent.intent;
}

async function reconcileRelease(decision: Extract<
  ReturnType<typeof releaseQueueDecision>,
  { kind: 'release' }
>) {
  const existingTag = await githubTagCommit(decision.tag);
  if (existingTag && existingTag !== decision.item.commit) {
    throw new Error(
      `Tag ${decision.tag} points at ${existingTag}, not queued merge ${decision.item.commit}.`,
    );
  }
  if (!existingTag) {
    const confirmed = await createTag(decision.tag, decision.item.commit);
    if (confirmed !== decision.item.commit) {
      throw new Error(`Tag ${decision.tag} was not atomically reserved at the queued merge.`);
    }
    console.log(
      `${dryRun ? 'Would reserve' : 'Reserved'} ${decision.tag} for PR #${decision.item.pullRequest} at ${decision.item.commit}.`,
    );
  } else {
    console.log(`Reusing ${decision.tag} at ${decision.item.commit}.`);
  }

  const release = await githubRelease(decision.tag);
  if (release === 'published') {
    console.log(`${decision.tag} is already published; the next queue wake-up may continue.`);
    return;
  }
  const recovery = releaseRecoveryDecision(
    release ?? 'missing',
    exactReleaseRuns(
      await workflowRuns('release.yml', undefined, 'main'),
      decision.tag,
    ),
  );
  if (recovery.kind === 'wait') {
    console.log(
      `Release ${decision.tag} is already ${recovery.run.status} in run ${recovery.run.id}.`,
    );
    return;
  }
  if (recovery.kind === 'error' && recovery.reason === 'success-without-result') {
    throw new Error(
      `A Release run succeeded for ${decision.tag}, but no published release exists. Refusing a duplicate start.`,
    );
  }
  if (recovery.kind === 'error') {
    throw new Error(
      `Release ${decision.tag} already used its automatic recovery attempt.`,
    );
  }
  if (recovery.kind === 'rerun') {
    await mutateGithub(
      `/repos/${repository}/actions/runs/${recovery.run.id}/rerun`,
      {},
    );
    console.log(
      `${dryRun ? 'Would rerun' : 'Rerunning'} release run ${recovery.run.id} for ${decision.tag}.`,
    );
    return;
  }
  await mutateGithub(
    `/repos/${repository}/actions/workflows/release.yml/dispatches`,
    { inputs: { 'release-tag': decision.tag }, ref: 'main' },
  );
  console.log(
    `${dryRun ? 'Would dispatch' : 'Dispatched'} signed release ${decision.tag}.`,
  );
}

async function reconcileProductionDeploy(commit: string, version: string) {
  const runs = exactProductionRuns(
    await workflowRuns('deploy-production.yml', commit, 'main'),
    commit,
    version,
  );
  const decision = workflowRecoveryDecision(runs);
  if (decision.kind === 'wait') {
    console.log(`Production run ${decision.run.id} is already ${decision.run.status}.`);
    return;
  }
  if (decision.kind === 'complete') {
    console.log(`Production run ${decision.run.id} already succeeded for ${commit}.`);
    return;
  }
  if (decision.kind === 'error') {
    throw new Error(`Production for ${commit} used its automatic recovery attempt.`);
  }
  if (decision.kind === 'rerun') {
    await mutateGithub(
      `/repos/${repository}/actions/runs/${decision.run.id}/rerun`,
      {},
    );
    console.log(
      `${dryRun ? 'Would rerun' : 'Rerunning'} Production run ${decision.run.id} for ${commit}.`,
    );
    return;
  }
  writeOutput('deploy_required', 'true');
  console.log(`Current main ${commit} requires one exact Production dispatch.`);
}

async function mergedPullRequestNumber(commit: string) {
  const response = await githubFetch(`/repos/${repository}/commits/${commit}/pulls`);
  if (!response.ok) {
    throw new Error(`Could not identify the pull request merged as ${commit}.`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('GitHub returned invalid pull request data.');
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
  if (!response.ok) throw new Error(`Could not inspect GitHub Release ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.tag_name !== tag || typeof body.draft !== 'boolean') {
    throw new Error(`GitHub returned invalid publication data for ${tag}.`);
  }
  if (body.draft) return 'draft' as const;
  if (typeof body.published_at !== 'string' || !body.published_at.trim()) {
    throw new Error(`GitHub Release ${tag} has no publication proof.`);
  }
  return 'published' as const;
}

async function githubTagCommit(tag: string) {
  const response = await githubFetch(`/repos/${repository}/git/ref/tags/${tag}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Could not verify tag ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.object) || typeof body.object.sha !== 'string') {
    throw new Error(`GitHub returned an invalid target for ${tag}.`);
  }
  if (body.object.type === 'commit') {
    return requiredCommit(body.object.sha, `${tag} target`);
  }
  if (body.object.type !== 'tag') throw new Error(`${tag} is not a Git commit tag.`);
  const annotated = await githubFetch(
    `/repos/${repository}/git/tags/${body.object.sha}`,
  );
  if (!annotated.ok) throw new Error(`Could not resolve annotated tag ${tag}.`);
  const tagBody: unknown = await annotated.json();
  if (
    !isRecord(tagBody) || !isRecord(tagBody.object) ||
    tagBody.object.type !== 'commit' || typeof tagBody.object.sha !== 'string'
  ) throw new Error(`${tag} does not resolve directly to a Git commit.`);
  return requiredCommit(tagBody.object.sha, `${tag} target`);
}

async function githubBranchCommit(branch: string) {
  const response = await githubFetch(`/repos/${repository}/git/ref/heads/${branch}`);
  if (!response.ok) throw new Error(`Could not resolve protected branch ${branch}.`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) || !isRecord(body.object) || body.object.type !== 'commit' ||
    typeof body.object.sha !== 'string'
  ) throw new Error(`GitHub returned an invalid protected branch target.`);
  return requiredCommit(body.object.sha, `${branch} target`);
}

async function workflowRuns(
  workflow: string,
  commit: string | undefined,
  branch: string,
) {
  const query = new URLSearchParams({
    event: 'workflow_dispatch',
    per_page: '100',
  });
  if (commit) query.set('head_sha', commit);
  const response = await githubFetch(
    `/repos/${repository}/actions/workflows/${workflow}/runs?${query}`,
  );
  if (!response.ok) throw new Error(`Could not inspect ${workflow} runs.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
    throw new Error(`GitHub returned invalid ${workflow} run data.`);
  }
  return body.workflow_runs.map(parseWorkflowRun).filter(
    (run) => (!commit || run.headSha === commit) &&
      run.headBranch === branch,
  ).sort((left, right) => right.id - left.id);
}

function parseWorkflowRun(value: unknown): HandoffRun {
  if (
    !isRecord(value) || typeof value.id !== 'number' ||
    typeof value.head_sha !== 'string' || typeof value.head_branch !== 'string' ||
    typeof value.display_title !== 'string' || typeof value.status !== 'string' ||
    typeof value.run_attempt !== 'number' ||
    !(typeof value.conclusion === 'string' || value.conclusion === null)
  ) throw new Error('GitHub returned an invalid workflow run.');
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
  if (dryRun) return commit;
  const response = await githubFetch(`/repos/${repository}/git/refs`, {
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit }),
    method: 'POST',
  });
  if (response.ok) {
    const body: unknown = await response.json();
    if (
      !isRecord(body) || body.ref !== `refs/tags/${tag}` ||
      !isRecord(body.object) || typeof body.object.sha !== 'string'
    ) {
      throw new Error(`GitHub returned an invalid reservation for ${tag}.`);
    }
    return requiredCommit(body.object.sha, `${tag} reservation target`);
  }
  if (response.status === 422) {
    const existing = await githubTagCommit(tag);
    if (existing === commit) return existing;
  }
  throw new Error(`Could not reserve ${tag} at ${commit} (${response.status}).`);
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
        detail ? `: ${detail.slice(0, 300)}` : ''
      }`,
    );
  }
}

function isFirstParentAncestor(ancestor: string, descendant: string) {
  return gitOutput(['rev-list', '--first-parent', descendant])
    .split('\n')
    .includes(ancestor);
}

function packageVersionAt(commit: string) {
  const parsed: unknown = JSON.parse(
    gitOutput(['show', `${commit}:package.json`], false),
  );
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`${commit}:package.json has no string version.`);
  }
  return parsed.version;
}

function pathExistsAt(commit: string, path: string) {
  const result = spawnSync('git', ['cat-file', '-e', `${commit}:${path}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return true;
  if (result.status === 128) return false;
  throw new Error(
    `Could not inspect ${path} at ${commit}: ${result.stderr.trim()}`,
  );
}

function markerMatchesAt(commit: string) {
  return gitOutput([
    'show', `${commit}:${releaseIntentEnforcementPath}`,
  ], false) === releaseIntentEnforcementSource;
}

function githubFetch(path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${requiredGithubToken()}`,
      'content-type': 'application/json',
      'user-agent': 'project-space-release-queue',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
}

function requiredGithubToken() {
  const token = process.env.GH_TOKEN?.trim();
  if (!token) throw new Error('GH_TOKEN is required for the trusted release queue.');
  return token;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
