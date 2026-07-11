import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  GitHistoryCommit,
  GitHistoryResult,
  GitHubAuthSource,
  GitHubBranchRecord,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubIssueRecord,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitHubPipelineStatusResult,
  GitHubRepositoryDetailsResult,
  GitHubWorkflowRunConclusion,
  GitHubWorkflowRunSummary
} from '../src/shared/project-space-api';
import { loadRepositoryDevelopmentLinks } from './local-github-development-links';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from './local-auth-store';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured,
  readGitHubOAuthToken,
  writeGitHubOAuthToken
} from './local-database-store';
import { PostgresGitHubCatalogCacheStore } from './github-catalog-cache-store';
import { GitHubCatalogService } from './github-catalog-service';
import { getGitHubCatalogRequestTiming } from './github-catalog-timing';

interface StoredGitHubToken {
  accessToken: string;
  createdAt: string;
  login?: string;
  scope?: string;
  tokenType?: string;
}

interface GitHubApiRepository {
  default_branch?: string;
  description?: string | null;
  full_name: string;
  html_url: string;
  id: number;
  name: string;
  owner: {
    login: string;
  };
  private: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
}

interface GitHubApiUser {
  login?: string;
}

interface GitHubApiBranch {
  name: string;
  commit?: {
    sha?: string;
    html_url?: string;
  };
}

interface GitHubApiCommitListItem {
  commit?: {
    author?: {
      date?: string | null;
      name?: string | null;
    } | null;
    committer?: {
      date?: string | null;
    } | null;
    message?: string | null;
  };
  parents?: Array<{ sha?: string }>;
  sha: string;
}

interface GitHubApiIssue {
  body?: string | null;
  html_url: string;
  labels?: Array<{ name?: string }>;
  number: number;
  pull_request?: unknown;
  state: 'open' | 'closed';
  title: string;
  updated_at?: string | null;
  user?: {
    login?: string;
  } | null;
}

export interface TokenResolution {
  login?: string;
  source: GitHubAuthSource;
  token: string;
}

const projectSpaceDirectory = join(homedir(), '.project-space');
const githubTokenFile = join(projectSpaceDirectory, 'github-oauth.json');
const githubApiBaseUrl = 'https://api.github.com';
const githubDeviceCodeUrl = 'https://github.com/login/device/code';
const githubAccessTokenUrl = 'https://github.com/login/oauth/access_token';
const githubRequestTimeoutMs = 6_000;
const catalogRefreshTimeoutMs = 10_000;
const catalogDatabaseTimeoutMs = 2_000;
export const githubOAuthClientIdMissingMessage = 'Set GITHUB_OAUTH_CLIENT_ID to enable GitHub OAuth.';

function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

export function getGitHubClientId() {
  return (
    process.env.GITHUB_OAUTH_CLIENT_ID ??
    process.env.PROJECT_SPACE_GITHUB_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID ??
    ''
  );
}

function createEmptyCatalog(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubCatalogResult {
  return {
    checkedAt: new Date().toISOString(),
    message,
    repositories: [],
    status
  };
}

function readStoredToken(): StoredGitHubToken | null {
  if (!existsSync(githubTokenFile)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(githubTokenFile, 'utf-8')) as StoredGitHubToken;

    return payload.accessToken ? payload : null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: StoredGitHubToken) {
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(githubTokenFile, JSON.stringify(token, null, 2), {
    mode: 0o600
  });
}

export async function requestGitHub<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${githubApiBaseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(githubRequestTimeoutMs),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers
    }
  });

  if (!response.ok) {
    let message = `GitHub request failed with ${response.status}.`;

    try {
      const payload = (await response.json()) as { message?: string };

      if (payload.message) {
        message = `GitHub request failed: ${payload.message} (${response.status}).`;
      }
    } catch {
      // Keep the status-only message when GitHub does not return JSON.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function readLogin(token: string) {
  try {
    const user = await requestGitHub<GitHubApiUser>('/user', token);

    return user.login;
  } catch {
    return undefined;
  }
}

export async function resolveToken(): Promise<TokenResolution | null> {
  const currentSession = getCurrentAuthSession();

  if (isProjectSpaceAuthRequired() && !currentSession) {
    return null;
  }

  if (currentSession && isDatabaseConfigured()) {
    const storedForUser = await readGitHubOAuthToken(currentSession.userId);

    if (storedForUser) {
      return {
        login: storedForUser.login ?? currentSession.login,
        source: 'stored-oauth',
        token: storedForUser.accessToken
      };
    }
  }

  const stored = !isProjectSpaceAuthRequired() ? readStoredToken() : null;

  if (stored) {
    return {
      login: stored.login,
      source: 'stored-oauth',
      token: stored.accessToken
    };
  }

  if (isProjectSpaceAuthRequired() && process.env.PROJECT_SPACE_ALLOW_GLOBAL_GITHUB_TOKEN !== '1') {
    return null;
  }

  const environmentToken = process.env.GITHUB_TOKEN;

  if (environmentToken) {
    return {
      login: await readLogin(environmentToken),
      source: 'environment',
      token: environmentToken
    };
  }

  return null;
}

export async function resolveOAuthToken(): Promise<TokenResolution | null> {
  const currentSession = getCurrentAuthSession();

  if (isProjectSpaceAuthRequired() && !currentSession) {
    return null;
  }

  if (currentSession && isDatabaseConfigured()) {
    const storedForUser = await readGitHubOAuthToken(currentSession.userId);

    if (storedForUser) {
      return {
        login: storedForUser.login ?? currentSession.login,
        source: 'stored-oauth',
        token: storedForUser.accessToken
      };
    }
  }

  const stored = !isProjectSpaceAuthRequired() ? readStoredToken() : null;

  if (stored) {
    return {
      login: stored.login,
      source: 'stored-oauth',
      token: stored.accessToken
    };
  }

  return null;
}

async function listRepositories(token: string) {
  return requestGitHub<GitHubApiRepository[]>(
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100',
    token
  );
}

async function listRepositoriesConditional(token: string, etag?: string, signal?: AbortSignal) {
  const response = await fetch(
    `${githubApiBaseUrl}/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(etag ? { 'If-None-Match': etag } : {}),
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(githubRequestTimeoutMs)]) : AbortSignal.timeout(githubRequestTimeoutMs)
    }
  );
  if (response.status === 304) return { etag, notModified: true as const, repositories: [] };
  if (!response.ok) throw new Error(`GitHub repository request failed with ${response.status}.`);
  return {
    etag: response.headers.get('etag') ?? undefined,
    notModified: false as const,
    repositories: await response.json() as GitHubApiRepository[]
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
  signal?: AbortSignal
) {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) throw signal.reason;
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

function toCatalogRepository(repo: GitHubApiRepository): GitHubCatalogRepository {
  return {
    defaultBranch: repo.default_branch,
    description: repo.description ?? undefined,
    fullName: repo.full_name,
    id: repo.id,
    isPrivate: repo.private,
    name: repo.name,
    owner: repo.owner.login,
    projectConfig: {
      projectYaml: false,
      status: 'unknown',
      templateLock: false
    },
    pushedAt: repo.pushed_at ?? undefined,
    updatedAt: repo.updated_at ?? undefined,
    url: repo.html_url
  };
}

async function refreshGitHubCatalog(etag?: string, signal?: AbortSignal) {
  const startedAt = performance.now();
  const tokenStartedAt = performance.now();
  const auth = await resolveToken();
  const tokenLookupMs = performance.now() - tokenStartedAt;

  if (!auth) {
    return { catalog: createEmptyCatalog(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId()
        ? 'Connect GitHub to load the remote project catalog.'
        : githubOAuthClientIdMissingMessage
    ), timings: { tokenLookupMs, totalMs: performance.now() - startedAt } };
  }

  try {
    const githubStartedAt = performance.now();
    const listed = await listRepositoriesConditional(auth.token, etag, signal);
    const githubListMs = performance.now() - githubStartedAt;
    if (listed.notModified) {
      return { catalog: createEmptyCatalog('connected'), etag: listed.etag, notModified: true, timings: { githubMs: githubListMs, tokenLookupMs, totalMs: performance.now() - startedAt } };
    }
    const normalizationStartedAt = performance.now();
    const repositories = listed.repositories.map(toCatalogRepository);
    const normalizationMs = performance.now() - normalizationStartedAt;
    const githubMs = normalizationStartedAt - githubStartedAt;

    const catalog = {
      auth: {
        login: auth.login,
        source: auth.source
      },
      checkedAt: new Date().toISOString(),
      repositories,
      status: 'connected'
    } satisfies GitHubCatalogResult;
    return { catalog, etag: listed.etag, timings: { githubMs, normalizationMs, tokenLookupMs, totalMs: performance.now() - startedAt } };
  } catch (error) {
    return { catalog: createEmptyCatalog(
      'error',
      error instanceof Error ? error.message : 'Could not load GitHub repositories.'
    ), timings: { tokenLookupMs, totalMs: performance.now() - startedAt } };
  }
}

function refreshGitHubCatalogWithDeadline(etag?: string) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('GitHub catalog refresh timed out.')),
    catalogRefreshTimeoutMs
  );
  return refreshGitHubCatalog(etag, controller.signal).finally(() => clearTimeout(timer));
}

export async function getGitHubCatalog(options: { forceRefresh?: boolean } = {}): Promise<GitHubCatalogResult> {
  const requestStartedAt = performance.now();
  const session = getCurrentAuthSession();
  if (!session || !isDatabaseConfigured()) {
    const result = await refreshGitHubCatalogWithDeadline();
    return { ...result.catalog, timings: { ...result.timings, authMs: getGitHubCatalogRequestTiming()?.authMs, totalMs: performance.now() - requestStartedAt } };
  }
  const client = await bounded(getMachineConnectionDatabaseClient(), catalogDatabaseTimeoutMs, 'Catalog database timed out.');
  const postgresStore = new PostgresGitHubCatalogCacheStore(client);
  const store = {
    read: (userId: string, scope: string) => bounded(postgresStore.read(userId, scope), catalogDatabaseTimeoutMs, 'Catalog cache read timed out.'),
    write: (snapshot: Parameters<typeof postgresStore.write>[0]) => bounded(postgresStore.write(snapshot), catalogDatabaseTimeoutMs, 'Catalog cache write timed out.'),
    markRefreshing: (userId: string, scope: string, attemptedAt: string) => bounded(postgresStore.markRefreshing(userId, scope, attemptedAt), catalogDatabaseTimeoutMs, 'Catalog cache update timed out.'),
    markFailed: (userId: string, scope: string, message: string, attemptedAt: string) => bounded(postgresStore.markFailed(userId, scope, message, attemptedAt), catalogDatabaseTimeoutMs, 'Catalog cache update timed out.')
  };
  const service = new GitHubCatalogService({ refresh: refreshGitHubCatalogWithDeadline, store, userId: session.userId });
  const result = await service.get(options.forceRefresh);
  const timing = getGitHubCatalogRequestTiming();
  const sanitized = { ...result, timings: { ...result.timings, authMs: timing?.authMs, totalMs: timing ? performance.now() - timing.requestStartedAt : performance.now() - requestStartedAt } };
  console.info(JSON.stringify({ event: 'github_catalog_request', cache: sanitized.cache?.state ?? 'none', status: sanitized.status, timings: sanitized.timings }));
  return sanitized;
}

function createEmptyRepositoryDetails(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubRepositoryDetailsResult {
  return {
    branches: [],
    checkedAt: new Date().toISOString(),
    issues: [],
    message,
    pullRequests: [],
    status
  };
}

function mapGitHubIssue(issue: GitHubApiIssue): GitHubIssueRecord {
  return {
    author: issue.user?.login,
    body: issue.body ?? undefined,
    labels: issue.labels?.map((label) => label.name).filter((name): name is string => Boolean(name)) ?? [],
    number: issue.number,
    state: issue.state,
    title: issue.title,
    updatedAt: issue.updated_at ?? undefined,
    url: issue.html_url
  };
}

function branchWebUrl(repoUrl: string, branchName: string) {
  return `${repoUrl}/tree/${encodeURIComponent(branchName).replace(/%2F/g, '/')}`;
}

function normalizeGitHubHistoryLimit(limit?: number) {
  if (!Number.isFinite(limit)) {
    return 100;
  }

  return Math.max(1, Math.min(300, Math.floor(limit ?? 100)));
}

function normalizeGitHubRef(ref?: string) {
  return ref
    ?.replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .trim();
}

function mapGitHubCommit(
  commit: GitHubApiCommitListItem,
  refsByHash: Map<string, string[]>
): GitHistoryCommit {
  const message = commit.commit?.message ?? '';
  const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? '';

  return {
    author: commit.commit?.author?.name ?? '',
    date: date.slice(0, 10),
    hash: commit.sha,
    parents: commit.parents?.map((parent) => parent.sha).filter((sha): sha is string => Boolean(sha)) ?? [],
    refs: refsByHash.get(commit.sha) ?? [],
    subject: message.split('\n')[0] ?? ''
  };
}

async function loadGitHubBranchCommits(
  fullName: string,
  branchName: string,
  token: string,
  limit: number
) {
  const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
  const commits: GitHubApiCommitListItem[] = [];
  let page = 1;

  while (commits.length < limit) {
    const perPage = Math.min(100, limit - commits.length);
    const payload = await requestGitHub<GitHubApiCommitListItem[]>(
      `/repos/${repoPath}/commits?sha=${encodeURIComponent(branchName)}&per_page=${perPage}&page=${page}`,
      token
    );

    commits.push(...payload);

    if (payload.length < perPage) {
      break;
    }

    page += 1;
  }

  return commits;
}

function addBranchRefs(
  refsByHash: Map<string, string[]>,
  branch: GitHubApiBranch,
  defaultBranch?: string
) {
  const hash = branch.commit?.sha;

  if (!hash) {
    return;
  }

  const refs = refsByHash.get(hash) ?? [];
  refs.push(`origin/${branch.name}`);

  if (branch.name === defaultBranch) {
    refs.push(branch.name, 'origin/HEAD');
  }

  refsByHash.set(hash, Array.from(new Set(refs)));
}

export async function getGitHubHistory({
  fullName,
  limit,
  ref
}: {
  fullName: string;
  limit?: number;
  ref?: string;
}): Promise<GitHistoryResult> {
  const auth = await resolveToken();

  if (!auth) {
    return {
      commits: [],
      cwd: fullName,
      isRepository: false,
      message: getGitHubClientId()
        ? 'Connect GitHub to load repository history.'
        : githubOAuthClientIdMissingMessage,
      repositoryRoot: fullName
    };
  }

  try {
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const historyLimit = normalizeGitHubHistoryLimit(limit);
    const [repo, branches] = await Promise.all([
      requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token),
      requestGitHub<GitHubApiBranch[]>(
        `/repos/${repoPath}/branches?per_page=100`,
        auth.token
      )
    ]);
    const refsByHash = new Map<string, string[]>();
    const normalizedRef = normalizeGitHubRef(ref);
    const branchNames = normalizedRef
      ? [normalizedRef]
      : branches.map((branch) => branch.name);

    branches.forEach((branch) => addBranchRefs(refsByHash, branch, repo.default_branch));

    const commitsByHash = new Map<string, GitHubApiCommitListItem>();
    const perBranchLimit = normalizedRef ? historyLimit : Math.min(historyLimit, 100);
    const histories = await mapWithConcurrency(branchNames, 4, (branchName) =>
      loadGitHubBranchCommits(fullName, branchName, auth.token, perBranchLimit)
    );

    for (const branchCommits of histories) {
      for (const commit of branchCommits) {
        commitsByHash.set(commit.sha, commit);
      }
    }

    const commits = Array.from(commitsByHash.values())
      .sort((left, right) => {
        const leftDate = left.commit?.author?.date ?? left.commit?.committer?.date ?? '';
        const rightDate = right.commit?.author?.date ?? right.commit?.committer?.date ?? '';

        return rightDate.localeCompare(leftDate);
      })
      .slice(0, historyLimit)
      .map((commit) => mapGitHubCommit(commit, refsByHash));

    return {
      commits,
      cwd: fullName,
      isRepository: true,
      repositoryRoot: fullName
    };
  } catch (error) {
    return {
      commits: [],
      cwd: fullName,
      isRepository: false,
      message: error instanceof Error ? error.message : 'Could not load GitHub history.',
      repositoryRoot: fullName
    };
  }
}

export async function getGitHubRepositoryDetails(
  fullName: string
): Promise<GitHubRepositoryDetailsResult> {
  const auth = await resolveToken();

  if (!auth) {
    return createEmptyRepositoryDetails(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId()
        ? 'Connect GitHub to load repository details.'
        : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const [repo, branches, issues, developmentLinks] = await Promise.all([
      requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token),
      requestGitHub<GitHubApiBranch[]>(
        `/repos/${repoPath}/branches?per_page=30`,
        auth.token
      ),
      requestGitHub<GitHubApiIssue[]>(
        `/repos/${repoPath}/issues?state=all&per_page=100&sort=updated&direction=desc`,
        auth.token
      ),
      loadRepositoryDevelopmentLinks(fullName, auth.token)
    ]);

    return {
      branches: branches.map<GitHubBranchRecord>((branch) => ({
        commitSha: branch.commit?.sha,
        isDefault: branch.name === repo.default_branch,
        linkedIssueNumbers: Array.from(
          developmentLinks.linkedIssueNumbersByBranch.get(branch.name) ?? []
        ).sort((left, right) => left - right),
        name: branch.name,
        url: branchWebUrl(repo.html_url, branch.name)
      })),
      checkedAt: new Date().toISOString(),
      issues: issues
        .filter((issue) => !issue.pull_request)
        .map(mapGitHubIssue),
      pullRequests: developmentLinks.pullRequests,
      status: 'connected'
    };
  } catch (error) {
    return createEmptyRepositoryDetails(
      'error',
      error instanceof Error ? error.message : 'Could not load GitHub repository details.'
    );
  }
}

interface GitHubApiWorkflowRun {
  conclusion?: string | null;
  created_at?: string | null;
  display_title?: string | null;
  event?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  html_url?: string | null;
  id: number;
  name?: string | null;
  run_number?: number | null;
  run_started_at?: string | null;
  status?: string | null;
  updated_at?: string | null;
}

function createEmptyPipelineStatus(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubPipelineStatusResult {
  return {
    checkedAt: new Date().toISOString(),
    message,
    runs: [],
    status
  };
}

function mapWorkflowRun(run: GitHubApiWorkflowRun): GitHubWorkflowRunSummary {
  return {
    branch: run.head_branch ?? undefined,
    conclusion: (run.conclusion ?? undefined) as GitHubWorkflowRunConclusion | undefined,
    createdAt: run.created_at ?? undefined,
    displayTitle: run.display_title ?? undefined,
    event: run.event ?? undefined,
    headSha: run.head_sha ?? undefined,
    id: run.id,
    name: run.name ?? undefined,
    runNumber: run.run_number ?? undefined,
    runStartedAt: run.run_started_at ?? undefined,
    status: (run.status ?? 'completed') as GitHubWorkflowRunSummary['status'],
    updatedAt: run.updated_at ?? undefined,
    url: run.html_url ?? undefined
  };
}

export async function getGitHubPipelineStatus(
  fullName: string
): Promise<GitHubPipelineStatusResult> {
  const auth = await resolveToken();

  if (!auth) {
    return createEmptyPipelineStatus(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId()
        ? 'Connect GitHub to load pipeline status.'
        : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const payload = await requestGitHub<{ workflow_runs?: GitHubApiWorkflowRun[] }>(
      `/repos/${repoPath}/actions/runs?per_page=20`,
      auth.token
    );

    return {
      checkedAt: new Date().toISOString(),
      runs: (payload.workflow_runs ?? []).map(mapWorkflowRun),
      status: 'connected'
    };
  } catch (error) {
    return createEmptyPipelineStatus(
      'error',
      error instanceof Error ? error.message : 'Could not load GitHub workflow runs.'
    );
  }
}

export async function startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult> {
  const clientId = getGitHubClientId();

  if (!clientId) {
    return {
      message: githubOAuthClientIdMissingMessage,
      status: 'not-configured'
    };
  }

  const response = await fetch(githubDeviceCodeUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      scope: 'repo read:user'
    }),
    headers: {
      Accept: 'application/json'
    },
    method: 'POST'
  });
  const payload = (await response.json()) as {
    device_code?: string;
    error?: string;
    error_description?: string;
    expires_in?: number;
    interval?: number;
    user_code?: string;
    verification_uri?: string;
  };

  if (!response.ok || !payload.device_code) {
    return {
      message: payload.error_description ?? payload.error ?? 'Could not start GitHub OAuth.',
      status: 'error'
    };
  }

  return {
    deviceCode: payload.device_code,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 900) * 1000).toISOString(),
    intervalSeconds: payload.interval ?? 5,
    status: 'pending',
    userCode: payload.user_code,
    verificationUri: payload.verification_uri
  };
}

export async function pollGitHubOAuthDeviceFlow({
  deviceCode
}: GitHubOAuthDevicePollRequest): Promise<GitHubOAuthDevicePollResult> {
  const clientId = getGitHubClientId();

  if (!clientId) {
    return {
      message: githubOAuthClientIdMissingMessage,
      status: 'error'
    };
  }

  const response = await fetch(githubAccessTokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }),
    headers: {
      Accept: 'application/json'
    },
    method: 'POST'
  });
  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
    scope?: string;
    token_type?: string;
  };

  if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
    return {
      intervalSeconds: payload.interval,
      message: payload.error_description,
      status: 'pending'
    };
  }

  if (payload.error === 'expired_token') {
    return {
      message: payload.error_description,
      status: 'expired'
    };
  }

  if (payload.error === 'access_denied') {
    return {
      message: payload.error_description,
      status: 'denied'
    };
  }

  if (!response.ok || !payload.access_token) {
    return {
      message: payload.error_description ?? payload.error ?? 'Could not finish GitHub OAuth.',
      status: 'error'
    };
  }

  const login = await readLogin(payload.access_token);
  const storedToken = {
    accessToken: payload.access_token,
    createdAt: new Date().toISOString(),
    login,
    scope: payload.scope,
    tokenType: payload.token_type
  };
  const currentSession = getCurrentAuthSession();

  if (currentSession) {
    await writeGitHubOAuthToken(currentSession.userId, storedToken);
  } else {
    writeStoredToken(storedToken);
  }

  return {
    catalog: await getGitHubCatalog(),
    status: 'connected'
  };
}
