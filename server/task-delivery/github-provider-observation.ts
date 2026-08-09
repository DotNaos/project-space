import { createHash } from 'node:crypto';

import {
  GitHubRequestError
} from '../local-github-catalog';
import type {
  GitHubCatalogRepository,
  GitHubRepositoryDetailsResult,
  ProjectSpaceBackend
} from '../../src/shared/project-space-api';
import type {
  TaskDeliveryProviderObservation,
  TaskDeliveryProviderTarget,
  TaskDeliveryRequiredCheck
} from './contracts';
import { readUnresolvedGitHubReviewThreadCount } from './github-provider-review-threads';

export interface GitHubProviderRequest {
  <T>(path: string, token: string, init?: RequestInit): Promise<T>;
}

export interface GitHubProviderGraphQLRequest {
  <T>(token: string, query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface GitHubTaskDeliveryProviderDependencies {
  backend: Pick<ProjectSpaceBackend,
    'getDeployedEnvironmentStatus' | 'getGitHubCatalog' | 'getGitHubRepositoryDetails'>;
  now?: () => string;
  requestGitHub: GitHubProviderRequest;
  requestGitHubGraphQL: GitHubProviderGraphQLRequest;
  resolveOAuthToken: () => Promise<{ token: string } | null>;
}

export interface GitHubApiPullRequest {
  base?: { ref?: string | null } | null;
  body?: string | null;
  draft?: boolean | null;
  head?: {
    ref?: string | null;
    repo?: { full_name?: string | null } | null;
    sha?: string | null;
  } | null;
  html_url?: string | null;
  merge_commit_sha?: string | null;
  merged?: boolean | null;
  node_id?: string | null;
  number: number;
  state: 'closed' | 'open';
  title?: string | null;
}

export interface AuthorizedGitHubTarget {
  baseBranch: string;
  details: GitHubRepositoryDetailsResult;
  repository: GitHubCatalogRepository;
  taskNumber: number;
  token: string;
}

interface GitHubCheckRun {
  app?: { id?: number } | null;
  completed_at?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  id: number;
  name: string;
  started_at?: string | null;
  status?: string | null;
}

interface GitHubCommitStatus {
  context: string;
  created_at?: string | null;
  id: number;
  state: string;
  target_url?: string | null;
  updated_at?: string | null;
}

interface GitHubReview {
  body?: string | null;
  commit_id?: string | null;
  id: number;
  state?: string | null;
  submitted_at?: string | null;
  user?: { id?: number; login?: string | null } | null;
}

const fullCommit = /^[0-9a-f]{40}$/i;

export function safeHttpsUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function repoPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function taskNumber(taskId: string) {
  const candidate = taskId.startsWith('github:') ? taskId.split(':').at(-1) : taskId;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function authorizeGitHubTarget(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  target: TaskDeliveryProviderTarget
): Promise<{ blocked: string } | { context: AuthorizedGitHubTarget }> {
  if (target.providerKind !== 'github') return { blocked: 'unsupported_provider' };
  const number = taskNumber(target.taskId);
  if (!number) return { blocked: 'target_unavailable' };
  try {
    const catalog = await dependencies.backend.getGitHubCatalog();
    if (catalog.status !== 'connected') return { blocked: 'provider_authorization_required' };
    const repository = catalog.repositories.find((candidate) =>
      String(candidate.id) === target.repositoryId ||
      candidate.fullName.toLowerCase() === target.repositoryId.toLowerCase());
    if (!repository) return { blocked: 'target_unavailable' };
    const details = await dependencies.backend.getGitHubRepositoryDetails(repository.fullName);
    if (details.status !== 'connected') return { blocked: 'provider_authorization_required' };
    if (!details.issues.some((issue) => issue.number === number)) return { blocked: 'target_unavailable' };
    const baseBranch = repository.defaultBranch ?? details.branches.find((branch) => branch.isDefault)?.name;
    if (!baseBranch) return { blocked: 'target_unavailable' };
    const auth = await dependencies.resolveOAuthToken();
    if (!auth) return { blocked: 'provider_authorization_required' };
    return { context: { baseBranch, details, repository, taskNumber: number, token: auth.token } };
  } catch {
    return { blocked: 'provider_authorization_required' };
  }
}

function taskMarker(task: number) {
  return `<!-- project-space-task:${task} -->`;
}

function linksTask(body: string | null | undefined, task: number, repositoryFullName: string) {
  if (!body) return false;
  if (body.includes(taskMarker(task))) return true;
  const escaped = String(task).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:([\\w.-]+\\/[\\w.-]+))?#${escaped}\\b`,
    'gi'
  );
  for (const match of body.matchAll(expression)) {
    if (!match[1] || match[1].toLowerCase() === repositoryFullName.toLowerCase()) return true;
  }
  return false;
}

export async function readTargetPullRequest(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  target: TaskDeliveryProviderTarget
): Promise<{ ambiguous?: true; pullRequest?: GitHubApiPullRequest }> {
  const owner = context.repository.owner;
  const path = repoPath(context.repository.fullName);
  const listed = await dependencies.requestGitHub<GitHubApiPullRequest[]>(
    `/repos/${path}/pulls?state=all&head=${encodeURIComponent(`${owner}:${target.branch}`)}&per_page=100`,
    context.token
  );
  if (listed.length >= 100) return { ambiguous: true };
  const linkedNumbers = new Set(context.details.pullRequests
    .filter((pullRequest) => pullRequest.linkedIssueNumbers?.includes(context.taskNumber))
    .map((pullRequest) => pullRequest.number));
  const candidates = listed.filter((pullRequest) =>
    pullRequest.head?.ref === target.branch &&
    pullRequest.head?.repo?.full_name?.toLowerCase() === context.repository.fullName.toLowerCase() &&
    pullRequest.base?.ref === context.baseBranch &&
    (linkedNumbers.has(pullRequest.number) || linksTask(
      pullRequest.body,
      context.taskNumber,
      context.repository.fullName
    )));
  const open = candidates.filter((pullRequest) => pullRequest.state === 'open');
  if (open.length === 1) return { pullRequest: open[0] };
  if (open.length > 1 || candidates.length > 1) return { ambiguous: true };
  return { pullRequest: candidates[0] };
}

export async function readPullRequestByNumber(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  target: TaskDeliveryProviderTarget,
  number: number
) {
  const pullRequest = await dependencies.requestGitHub<GitHubApiPullRequest>(
    `/repos/${repoPath(context.repository.fullName)}/pulls/${number}`,
    context.token
  );
  const matches = pullRequest.head?.ref === target.branch &&
    pullRequest.head?.repo?.full_name?.toLowerCase() === context.repository.fullName.toLowerCase() &&
    pullRequest.base?.ref === context.baseBranch &&
    (context.details.pullRequests.some((candidate) =>
      candidate.number === number && candidate.linkedIssueNumbers?.includes(context.taskNumber)) ||
      linksTask(pullRequest.body, context.taskNumber, context.repository.fullName));
  return matches ? pullRequest : undefined;
}

async function readSourceCommit(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  branch: string
) {
  try {
    const ref = await dependencies.requestGitHub<{ object?: { sha?: string } }>(
      `/repos/${repoPath(context.repository.fullName)}/git/ref/heads/${encodeURIComponent(branch)}`,
      context.token
    );
    const commit = ref.object?.sha?.toLowerCase();
    return commit && fullCommit.test(commit) ? commit : '';
  } catch {
    return '';
  }
}

function checkState(value: { conclusion?: string | null; state?: string; status?: string | null }) {
  if (value.status && value.status !== 'completed') return 'pending' as const;
  const result = (value.conclusion ?? value.state ?? '').toLowerCase();
  if (['success', 'neutral', 'skipped'].includes(result)) return 'passing' as const;
  if (['pending', 'queued', 'in_progress', 'expected'].includes(result)) return 'pending' as const;
  return 'failing' as const;
}

async function readChecks(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  baseBranch: string,
  commit: string,
  observedAt: string
): Promise<TaskDeliveryProviderObservation['checks']> {
  const path = repoPath(context.repository.fullName);
  try {
    const [required, runs, statuses] = await Promise.all([
      readRequiredChecks(dependencies, context, path, baseBranch),
      dependencies.requestGitHub<{ check_runs?: GitHubCheckRun[]; total_count?: number }>(
        `/repos/${path}/commits/${commit}/check-runs?per_page=100`, context.token),
      dependencies.requestGitHub<{ statuses?: GitHubCommitStatus[] }>(
        `/repos/${path}/commits/${commit}/status?per_page=100`, context.token)
    ]);
    if ((runs.total_count ?? runs.check_runs?.length ?? 0) > 100 || (statuses.statuses?.length ?? 0) >= 100) {
      return { commit, required: [], state: 'unavailable' };
    }
    const checks = (required.checks ?? [])
      .filter((check): check is { app_id?: number | null; context: string } => Boolean(check.context))
      .map((check): { name: string; requiredAppId?: number } => ({
        name: check.context,
        ...(Number.isSafeInteger(check.app_id) && Number(check.app_id) > 0
          ? { requiredAppId: Number(check.app_id) }
          : {})
      }));
    const checkNames = new Set(checks.map((check) => check.name));
    const requirements: Array<{ name: string; requiredAppId?: number }> = [
      ...checks,
      ...(required.contexts ?? [])
        .filter((name) => !checkNames.has(name))
        .map((name): { name: string; requiredAppId?: number } => ({ name }))
    ].filter((requirement, index, all) => all.findIndex((candidate) => (
      candidate.name === requirement.name && candidate.requiredAppId === requirement.requiredAppId
    )) === index).sort((left, right) => (
      left.name.localeCompare(right.name) || (left.requiredAppId ?? 0) - (right.requiredAppId ?? 0)
    ));
    const evidence: Array<TaskDeliveryRequiredCheck & { url?: string }> = requirements.map((requirement) => {
      const run = runs.check_runs?.find((candidate) => (
        candidate.name === requirement.name &&
        (requirement.requiredAppId === undefined || candidate.app?.id === requirement.requiredAppId)
      ));
      const status = requirement.requiredAppId === undefined
        ? statuses.statuses?.find((candidate) => candidate.context === requirement.name)
        : undefined;
      const source = run ?? status;
      return {
        checkedAt: run?.completed_at ?? run?.started_at ?? status?.updated_at ?? status?.created_at ?? observedAt,
        commit,
        id: run ? `check-run:${run.id}` : status ? `status:${status.id}` :
          `required:${requirement.name}${requirement.requiredAppId ? `:${requirement.requiredAppId}` : ''}`,
        name: requirement.name,
        ...(requirement.requiredAppId ? { requiredAppId: requirement.requiredAppId } : {}),
        state: source ? checkState(source) : 'pending',
        url: safeHttpsUrl(run?.html_url ?? status?.target_url)
      };
    });
    const state = evidence.some((check) => check.state === 'failing') ? 'failing' :
      evidence.some((check) => check.state === 'pending') ? 'pending' : 'passing';
    return { commit, fingerprint: fingerprint(evidence), required: evidence, state };
  } catch {
    return { commit, required: [], state: 'unavailable' };
  }
}

async function readRequiredChecks(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  path: string,
  baseBranch: string
) {
  try {
    return await dependencies.requestGitHub<{
      checks?: Array<{ app_id?: number | null; context?: string }>;
      contexts?: string[];
    }>(
      `/repos/${path}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
      context.token
    );
  } catch (error) {
    if (error instanceof GitHubRequestError && error.statusCode === 404) {
      const branch = await dependencies.requestGitHub<{ protected?: boolean }>(
        `/repos/${path}/branches/${encodeURIComponent(baseBranch)}`,
        context.token
      );
      if (branch.protected === false) return { checks: [], contexts: [] };
    }
    throw error;
  }
}

async function readAllReviews(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  pullRequestNumber: number
) {
  const reviews: GitHubReview[] = [];
  const path = repoPath(context.repository.fullName);
  for (let page = 1; page <= 5; page += 1) {
    const batch = await dependencies.requestGitHub<GitHubReview[]>(
      `/repos/${path}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`, context.token);
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
  throw new Error('GitHub review evidence is incomplete.');
}

export async function hasGitHubReviewRequest(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  pullRequestNumber: number,
  commit: string,
  marker: string
) {
  const reviews = await readAllReviews(dependencies, context, pullRequestNumber);
  return reviews.some((review) => review.state === 'COMMENT' &&
    review.commit_id?.toLowerCase() === commit.toLowerCase() && review.body?.includes(marker));
}

async function readReviews(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  pullRequest: GitHubApiPullRequest,
  commit: string,
  observedAt: string
): Promise<TaskDeliveryProviderObservation['review']> {
  try {
    const [reviews, unresolvedThreads] = await Promise.all([
      readAllReviews(dependencies, context, pullRequest.number),
      readUnresolvedGitHubReviewThreadCount(dependencies, context, pullRequest.number)
    ]);
    const latest = new Map<string, GitHubReview>();
    for (const review of reviews) {
      if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state ?? '')) continue;
      const actor = String(review.user?.id ?? review.user?.login ?? review.id);
      const current = latest.get(actor);
      if (!current || (review.submitted_at ?? '').localeCompare(current.submitted_at ?? '') >= 0) {
        latest.set(actor, review);
      }
    }
    const current = [...latest.values()].filter((review) => review.commit_id?.toLowerCase() === commit);
    const requestFingerprint = reviews
      .filter((review) => review.state === 'COMMENT' && review.commit_id?.toLowerCase() === commit)
      .sort((left, right) => (right.submitted_at ?? '').localeCompare(left.submitted_at ?? ''))
      .map((review) => review.body?.match(/<!-- project-space-review-request:([0-9a-f]{64}) -->/i)?.[1]
        ?.toLowerCase())
      .find((candidate): candidate is string => Boolean(candidate));
    const state = current.some((review) => review.state === 'CHANGES_REQUESTED')
      ? 'changes_requested' as const
      : current.some((review) => review.state === 'APPROVED')
        ? 'approved' as const
        : 'required' as const;
    return { checkedAt: observedAt, commit, fingerprint: fingerprint(current.map((review) => ({
      commit: review.commit_id, id: review.id, state: review.state,
      submittedAt: review.submitted_at, user: review.user?.id ?? review.user?.login
    }))), ...(requestFingerprint ? { requestFingerprint } : {}), state, unresolvedThreads };
  } catch {
    return { commit, state: 'unavailable' };
  }
}

export function unavailableObservation(
  observedAt: string,
  taskState: TaskDeliveryProviderObservation['taskState'] = 'open'
): TaskDeliveryProviderObservation {
  return {
    checks: { commit: '', required: [], state: 'unavailable' }, observedAt,
    preview: { state: 'unavailable' }, review: { state: 'unavailable' }, sourceCommit: '', taskState
  };
}

export async function observeAuthorizedTarget(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  target: TaskDeliveryProviderTarget,
  selectedPullRequest?: GitHubApiPullRequest
): Promise<TaskDeliveryProviderObservation> {
  const observedAt = dependencies.now?.() ?? new Date().toISOString();
  const taskState = context.details.issues.find((issue) => issue.number === context.taskNumber)?.state === 'closed'
    ? 'completed' as const
    : 'open' as const;
  try {
    const selected = selectedPullRequest ? { pullRequest: selectedPullRequest } :
      await readTargetPullRequest(dependencies, context, target);
    const sourceCommit = await readSourceCommit(dependencies, context, target.branch);
    if (selected.ambiguous) return { ...unavailableObservation(observedAt, taskState), sourceCommit };
    const pullRequest = selected.pullRequest;
    const headCommit = pullRequest?.head?.sha?.toLowerCase();
    const exactHead = headCommit && fullCommit.test(headCommit) ? headCommit : sourceCommit;
    const baseBranch = pullRequest?.base?.ref ?? context.baseBranch;
    const [checks, review, deploymentStatus] = await Promise.all([
      exactHead ? readChecks(dependencies, context, baseBranch, exactHead, observedAt) :
        Promise.resolve({ commit: '', required: [], state: 'unavailable' as const }),
      pullRequest && exactHead ? readReviews(dependencies, context, pullRequest, exactHead, observedAt) :
        Promise.resolve({ state: 'required' as const }),
      dependencies.backend.getDeployedEnvironmentStatus(context.repository.fullName).catch(() => undefined)
    ]);
    const mergeCommit = pullRequest?.merge_commit_sha?.toLowerCase();
    const environments = deploymentStatus?.status === 'available' ? deploymentStatus.environments : [];
    const expectedDeployed = mergeCommit && fullCommit.test(mergeCommit) ? mergeCommit : exactHead;
    const environment = environments.find((candidate) => candidate.deployedSha === expectedDeployed) ??
      environments.find((candidate) => candidate.id === 'prod') ?? environments[0];
    const origin = safeHttpsUrl(environment?.liveUrl);
    return {
      checks,
      deployment: environment?.deployedSha ? {
        deployedCommit: environment.deployedSha,
        environment: environment.id,
        health: environment.verification,
        origin,
        originFingerprint: fingerprint(origin ?? ''),
        originReachable: Boolean(origin && environment.verification === 'healthy'),
        runningVersion: environment.deployedVersion
      } : undefined,
      mergeCommit: mergeCommit && fullCommit.test(mergeCommit) ? mergeCommit : undefined,
      observedAt,
      preview: { headCommit: exactHead || undefined, state: 'unavailable' },
      pullRequest: pullRequest && exactHead && safeHttpsUrl(pullRequest.html_url) ? {
        baseBranch,
        draft: pullRequest.draft === true,
        headCommit: exactHead,
        number: pullRequest.number,
        state: pullRequest.merged ? 'merged' : pullRequest.state,
        url: safeHttpsUrl(pullRequest.html_url)!
      } : undefined,
      review,
      sourceCommit: sourceCommit || exactHead || '',
      taskState
    };
  } catch {
    return unavailableObservation(observedAt, taskState);
  }
}
