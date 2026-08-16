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
  GitHubIssueReference,
  GitHubIssueRecord,
  GitHubSubIssueProgress,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitHubPipelineStatusResult,
  GitHubRepositoryDetailsResult,
  GitHubWorkflowRunConclusion,
  GitHubWorkflowRunDetailResult,
  GitHubWorkflowJob,
  GitHubWorkflowRunKind,
  GitHubWorkflowRunStatus,
  GitHubWorkflowRunSummary
} from '../src/shared/project-space-api';
import { stripGitHubIssueCreationMarker } from '../src/shared/github-issue-creation-marker';
import { loadRepositoryDevelopmentLinks } from './local-github-development-links';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from './local-auth-store';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured,
  isGitHubOAuthReconnectRequired,
  readGitHubOAuthToken,
  writeGitHubOAuthToken
} from './local-database-store';
import { githubOAuthReconnectMessage } from './github-oauth-token-encryption';
import { PostgresGitHubCatalogCacheStore } from './github-catalog-cache-store';
import { GitHubCatalogService } from './github-catalog-service';
import { getGitHubCatalogRequestTiming } from './github-catalog-timing';
import { pullRequestHeadBranchRecord } from './github-branch-record';
import { projectSpaceLogger } from './observability';

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
  id: number;
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

interface GitHubApiIssueReference {
  number: number;
  repository?: {
    nameWithOwner?: string | null;
  } | null;
  title: string;
  url: string;
}

interface GitHubApiIssueHierarchyNode {
  number: number;
  parent?: GitHubApiIssueReference | null;
  subIssuesSummary?: {
    completed?: number | null;
    percentCompleted?: number | null;
    total?: number | null;
  } | null;
}

interface GitHubApiIssueHierarchyResponse {
  repository?: {
    issues?: {
      nodes?: Array<GitHubApiIssueHierarchyNode | null> | null;
    } | null;
  } | null;
}

export interface TokenResolution {
  login?: string;
  scope?: string;
  source: GitHubAuthSource;
  token: string;
}

export class GitHubRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly rateLimited: boolean,
    message = `GitHub request failed with ${statusCode}.`
  ) {
    super(message);
    this.name = 'GitHubRequestError';
  }
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

function githubConnectionRequired(defaultMessage: string) {
  const session = getCurrentAuthSession();
  const reconnectRequired = Boolean(
    session && isGitHubOAuthReconnectRequired(session.userId)
  );
  return {
    message: reconnectRequired ? githubOAuthReconnectMessage : defaultMessage,
    reconnectRequired
  };
}

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

function createGitHubConnectionRequiredCatalog(defaultMessage: string) {
  const clientConfigured = Boolean(getGitHubClientId());
  const connection = githubConnectionRequired(defaultMessage);
  return {
    ...createEmptyCatalog(
      clientConfigured ? 'auth-required' : 'not-configured',
      clientConfigured ? connection.message : githubOAuthClientIdMissingMessage
    ),
    ...(clientConfigured && connection.reconnectRequired
      ? { reconnectRequired: true }
      : {})
  } satisfies GitHubCatalogResult;
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

    const rateLimited = response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    throw new GitHubRequestError(response.status, rateLimited, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export type RequestGitHubGraphQL = <Result>(
  query: string,
  variables: Record<string, string>,
  token: string
) => Promise<Result>;

async function requestGitHubGraphQL<Result>(
  query: string,
  variables: Record<string, string>,
  token: string
): Promise<Result> {
  const response = await fetch(`${githubApiBaseUrl}/graphql`, {
    body: JSON.stringify({ query, variables }),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    method: 'POST',
    signal: AbortSignal.timeout(githubRequestTimeoutMs)
  });
  const payload = await response.json() as {
    data?: Result;
    errors?: Array<{ message?: string }>;
    message?: string;
  };

  if (!response.ok || payload.errors?.length || payload.data === undefined) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join('; ')
      || payload.message
      || `GitHub GraphQL request failed with ${response.status}.`;
    const rateLimited = response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    throw new GitHubRequestError(response.status, rateLimited, message);
  }

  return payload.data;
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
        scope: storedForUser.scope,
        source: 'stored-oauth',
        token: storedForUser.accessToken
      };
    }
  }

  const stored = !isProjectSpaceAuthRequired() ? readStoredToken() : null;

  if (stored) {
    return {
      login: stored.login,
      scope: stored.scope,
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
        scope: storedForUser.scope,
        source: 'stored-oauth',
        token: storedForUser.accessToken
      };
    }
  }

  const stored = !isProjectSpaceAuthRequired() ? readStoredToken() : null;

  if (stored) {
    return {
      login: stored.login,
      scope: stored.scope,
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
    return {
      catalog: createGitHubConnectionRequiredCatalog(
        'Connect GitHub to load the remote project catalog.'
      ),
      timings: { tokenLookupMs, totalMs: performance.now() - startedAt }
    };
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
    invalidate: (userId: string, scope: string) => bounded(postgresStore.invalidate(userId, scope), catalogDatabaseTimeoutMs, 'Catalog cache invalidation timed out.'),
    read: (userId: string, scope: string) => bounded(postgresStore.read(userId, scope), catalogDatabaseTimeoutMs, 'Catalog cache read timed out.'),
    write: (snapshot: Parameters<typeof postgresStore.write>[0]) => bounded(postgresStore.write(snapshot), catalogDatabaseTimeoutMs, 'Catalog cache write timed out.'),
    markRefreshing: (userId: string, scope: string, attemptedAt: string) => bounded(postgresStore.markRefreshing(userId, scope, attemptedAt), catalogDatabaseTimeoutMs, 'Catalog cache update timed out.'),
    markFailed: (userId: string, scope: string, message: string, attemptedAt: string) => bounded(postgresStore.markFailed(userId, scope, message, attemptedAt), catalogDatabaseTimeoutMs, 'Catalog cache update timed out.')
  };
  const service = new GitHubCatalogService({
    refresh: refreshGitHubCatalogWithDeadline,
    store,
    userId: session.userId,
    validateCachedConnection: async () => {
      const auth = await resolveToken();
      return auth
        ? null
        : createGitHubConnectionRequiredCatalog(
            'Connect GitHub to load the remote project catalog.'
          );
    }
  });
  const result = await service.get(options.forceRefresh);
  const timing = getGitHubCatalogRequestTiming();
  const sanitized = { ...result, timings: { ...result.timings, authMs: timing?.authMs, totalMs: timing ? performance.now() - timing.requestStartedAt : performance.now() - requestStartedAt } };
  projectSpaceLogger.info('github_catalog.request.completed', {
    cache: sanitized.cache?.state ?? 'none',
    component: 'github-catalog',
    status: sanitized.status,
    timings: sanitized.timings
  });
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

export function listRepositoryIssues(
  repoPath: string,
  token: string,
  request: typeof requestGitHub = requestGitHub
) {
  return request<GitHubApiIssue[]>(
    `/repos/${repoPath}/issues?state=all&per_page=100&sort=updated&direction=desc`,
    token
  );
}

export function mapGitHubIssue(
  issue: GitHubApiIssue,
  hierarchy?: ReadonlyMap<number, { parentIssue?: GitHubIssueReference; subIssueProgress?: GitHubSubIssueProgress }>
): GitHubIssueRecord {
  const body = stripGitHubIssueCreationMarker(issue.body ?? '');
  const issueHierarchy = hierarchy?.get(issue.number);
  return {
    author: issue.user?.login,
    body: body || undefined,
    id: issue.id,
    labels: issue.labels?.map((label) => label.name).filter((name): name is string => Boolean(name)) ?? [],
    number: issue.number,
    parentIssue: issueHierarchy?.parentIssue,
    state: issue.state,
    subIssueProgress: issueHierarchy?.subIssueProgress,
    title: issue.title,
    updatedAt: issue.updated_at ?? undefined,
    url: issue.html_url
  };
}

const issueHierarchyQuery = `
  query RepositoryIssueHierarchy($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, states: [OPEN, CLOSED], orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          parent {
            number
            title
            url
            repository {
              nameWithOwner
            }
          }
          subIssuesSummary {
            completed
            percentCompleted
            total
          }
        }
      }
    }
  }
`;

export function mapGitHubIssueHierarchy(
  nodes: Array<GitHubApiIssueHierarchyNode | null>
): ReadonlyMap<number, { parentIssue?: GitHubIssueReference; subIssueProgress?: GitHubSubIssueProgress }> {
  const hierarchy = new Map<number, { parentIssue?: GitHubIssueReference; subIssueProgress?: GitHubSubIssueProgress }>();

  for (const node of nodes) {
    if (!node) continue;
    const parentIssue = node.parent ? {
      number: node.parent.number,
      repositoryFullName: node.parent.repository?.nameWithOwner ?? undefined,
      title: node.parent.title,
      url: node.parent.url
    } : undefined;
    const progress = node.subIssuesSummary;
    const subIssueProgress = progress && typeof progress.completed === 'number'
      && typeof progress.percentCompleted === 'number'
      && typeof progress.total === 'number'
      && progress.total > 0
      ? {
          completed: progress.completed,
          percentCompleted: progress.percentCompleted,
          total: progress.total
        }
      : undefined;

    if (parentIssue || subIssueProgress) {
      hierarchy.set(node.number, { parentIssue, subIssueProgress });
    }
  }

  return hierarchy;
}

export async function listRepositoryIssueHierarchy(
  fullName: string,
  token: string,
  request: RequestGitHubGraphQL = requestGitHubGraphQL
) {
  const [owner, name] = fullName.split('/');
  if (!owner || !name || fullName.split('/').length !== 2) {
    throw new Error('GitHub repository names must use the owner/name format.');
  }

  const response = await request<GitHubApiIssueHierarchyResponse>(
    issueHierarchyQuery,
    { name, owner },
    token
  );
  return mapGitHubIssueHierarchy(response.repository?.issues?.nodes ?? []);
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
    const selectedTipSha = normalizedRef ? histories[0]?.[0]?.sha : undefined;

    if (normalizedRef && selectedTipSha) {
      addBranchRefs(
        refsByHash,
        { commit: { sha: selectedTipSha }, name: normalizedRef },
        repo.default_branch
      );
    }

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
        ? githubConnectionRequired('Connect GitHub to load repository details.').message
        : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const [repo, branches, issues, developmentLinks, issueHierarchy] = await Promise.all([
      requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token),
      requestGitHub<GitHubApiBranch[]>(
        `/repos/${repoPath}/branches?per_page=30`,
        auth.token
      ),
      listRepositoryIssues(repoPath, auth.token),
      loadRepositoryDevelopmentLinks(fullName, auth.token),
      listRepositoryIssueHierarchy(fullName, auth.token).catch((error) => {
        projectSpaceLogger.warn('github_catalog.issue_hierarchy_unavailable', {
          component: 'github-catalog',
          error: error instanceof Error ? error.message : 'Unknown GitHub issue hierarchy error',
          repository: fullName
        });
        return new Map();
      })
    ]);
    const branchRecords = new Map<string, GitHubBranchRecord>();

    for (const branch of branches) {
      branchRecords.set(branch.name, {
        commitSha: branch.commit?.sha,
        isDefault: branch.name === repo.default_branch,
        linkedIssueNumbers: Array.from(
          developmentLinks.linkedIssueNumbersByBranch.get(branch.name) ?? []
        ).sort((left, right) => left - right),
        name: branch.name,
        url: branchWebUrl(repo.html_url, branch.name)
      });
    }
    if (repo.default_branch && !branchRecords.has(repo.default_branch)) {
      branchRecords.set(repo.default_branch, {
        isDefault: true,
        linkedIssueNumbers: [],
        name: repo.default_branch,
        url: branchWebUrl(repo.html_url, repo.default_branch)
      });
    }
    for (const linkedBranch of developmentLinks.linkedBranches) {
      const current = branchRecords.get(linkedBranch.name);
      branchRecords.set(linkedBranch.name, {
        ...linkedBranch,
        ...current,
        commitSha: current?.commitSha ?? linkedBranch.commitSha,
        linkedIssueNumbers: Array.from(new Set([
          ...(current?.linkedIssueNumbers ?? []),
          ...(linkedBranch.linkedIssueNumbers ?? [])
        ])).sort((left, right) => left - right),
        url: current?.url ?? branchWebUrl(repo.html_url, linkedBranch.name)
      });
    }
    for (const pullRequest of developmentLinks.pullRequests) {
      if (
        pullRequest.state !== 'open' ||
        pullRequest.headRefPresent !== true ||
        pullRequest.isCrossRepository !== false ||
        pullRequest.headRepositoryFullName?.toLowerCase() !== fullName.toLowerCase() ||
        !pullRequest.headBranch ||
        !pullRequest.headSha
      ) {
        continue;
      }
      const current = branchRecords.get(pullRequest.headBranch);
      branchRecords.set(
        pullRequest.headBranch,
        pullRequestHeadBranchRecord({
          branchName: pullRequest.headBranch,
          commitSha: pullRequest.headSha,
          current,
          linkedIssueNumbers: pullRequest.linkedIssueNumbers ?? [],
          repositoryUrl: repo.html_url
        })
      );
    }

    return {
      branches: Array.from(branchRecords.values()),
      checkedAt: new Date().toISOString(),
      issues: issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => mapGitHubIssue(issue, issueHierarchy)),
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
  actor?: { login?: string | null } | null;
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
  run_attempt?: number | null;
  run_started_at?: string | null;
  status?: string | null;
  updated_at?: string | null;
  workflow_id?: number | null;
  path?: string | null;
}

interface GitHubApiWorkflowJob {
  completed_at?: string | null;
  conclusion?: string | null;
  id: number;
  name?: string | null;
  started_at?: string | null;
  status?: string | null;
  steps?: Array<{
    completed_at?: string | null;
    conclusion?: string | null;
    name?: string | null;
    number?: number | null;
    started_at?: string | null;
    status?: string | null;
  }>;
}

const workflowStatuses = new Set<GitHubWorkflowRunStatus>([
  'queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'
]);
const workflowConclusions = new Set<GitHubWorkflowRunConclusion>([
  'success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required',
  'neutral', 'stale'
]);

function normalizeWorkflowStatus(value: unknown): GitHubWorkflowRunStatus {
  return typeof value === 'string' && workflowStatuses.has(value as GitHubWorkflowRunStatus)
    ? value as GitHubWorkflowRunStatus : 'unknown';
}

function normalizeWorkflowConclusion(value: unknown): GitHubWorkflowRunConclusion | undefined {
  return typeof value === 'string' && workflowConclusions.has(value as GitHubWorkflowRunConclusion)
    ? value as GitHubWorkflowRunConclusion : undefined;
}

function workflowKind(path?: string | null, name?: string | null): GitHubWorkflowRunKind {
  const value = `${path ?? ''} ${name ?? ''}`.toLowerCase();
  if (value.includes('deploy')) return 'deployment';
  if (value.includes('release')) return 'release';
  if (value.includes('ci') || value.includes('test') || value.includes('check')) return 'ci';
  return 'other';
}

function durationMs(startedAt?: string | null, completedAt?: string | null) {
  if (!startedAt || !completedAt) return undefined;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
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

export function mapWorkflowRun(run: GitHubApiWorkflowRun): GitHubWorkflowRunSummary {
  const headSha = typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/i.test(run.head_sha)
    ? run.head_sha.toLowerCase()
    : undefined;
  return {
    actor: run.actor?.login ?? undefined,
    attempt: run.run_attempt ?? undefined,
    branch: run.head_branch ?? undefined,
    conclusion: normalizeWorkflowConclusion(run.conclusion),
    createdAt: run.created_at ?? undefined,
    displayTitle: run.display_title ?? undefined,
    event: run.event ?? undefined,
    headSha,
    id: run.id,
    kind: workflowKind(run.path, run.name),
    name: run.name ?? undefined,
    runNumber: run.run_number ?? undefined,
    runStartedAt: run.run_started_at ?? undefined,
    status: normalizeWorkflowStatus(run.status),
    updatedAt: run.updated_at ?? undefined,
    url: run.html_url ?? undefined,
    workflowId: run.workflow_id ?? undefined,
    workflowPath: run.path ?? undefined
  };
}

export function mapWorkflowJob(job: GitHubApiWorkflowJob, sequence: number): GitHubWorkflowJob {
  return {
    completedAt: job.completed_at ?? undefined,
    conclusion: normalizeWorkflowConclusion(job.conclusion),
    durationMs: durationMs(job.started_at, job.completed_at),
    id: job.id,
    name: job.name ?? `Job ${sequence}`,
    sequence,
    startedAt: job.started_at ?? undefined,
    status: normalizeWorkflowStatus(job.status),
    steps: (job.steps ?? []).map((step, index) => ({
      completedAt: step.completed_at ?? undefined,
      conclusion: normalizeWorkflowConclusion(step.conclusion),
      durationMs: durationMs(step.started_at, step.completed_at),
      name: step.name ?? `Step ${step.number ?? index + 1}`,
      number: step.number ?? index + 1,
      startedAt: step.started_at ?? undefined,
      status: normalizeWorkflowStatus(step.status)
    })).sort((left, right) => left.number - right.number)
  };
}

export async function getGitHubPipelineStatus(
  fullName: string,
  options: { page?: number; perPage?: number } = {}
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

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    return createEmptyPipelineStatus('error', 'Invalid repository selector.');
  }

  try {
    const page = Number.isSafeInteger(options.page) && options.page! > 0 ? options.page! : 1;
    const perPage = Number.isSafeInteger(options.perPage)
      ? Math.min(50, Math.max(1, options.perPage!))
      : 20;
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const payload = await requestGitHub<{ workflow_runs?: GitHubApiWorkflowRun[] }>(
      `/repos/${repoPath}/actions/runs?per_page=${perPage}&page=${page}`,
      auth.token
    );

    return {
      checkedAt: new Date().toISOString(),
      pagination: { hasNext: (payload.workflow_runs ?? []).length === perPage, page, perPage },
      runs: (payload.workflow_runs ?? []).map(mapWorkflowRun),
      status: 'connected'
    };
  } catch (error) {
    return createEmptyPipelineStatus(
      error instanceof GitHubRequestError && error.rateLimited ? 'rate-limited' : 'error',
      error instanceof GitHubRequestError && error.rateLimited
        ? 'GitHub rate limited the workflow request. Try again later.'
        : 'Could not load GitHub workflow runs.'
    );
  }
}

export async function getGitHubWorkflowRunDetail(
  fullName: string,
  runId: number
): Promise<GitHubWorkflowRunDetailResult> {
  const auth = await resolveToken();
  if (!auth) {
    return {
      checkedAt: new Date().toISOString(), jobs: [],
      message: getGitHubClientId() ? 'Connect GitHub to load workflow run details.' : githubOAuthClientIdMissingMessage,
      status: getGitHubClientId() ? 'auth-required' : 'not-configured'
    };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || !Number.isSafeInteger(runId) || runId <= 0) {
    return { checkedAt: new Date().toISOString(), jobs: [], message: 'Invalid workflow run selector.', status: 'error' };
  }
  const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
  try {
    const run = await requestGitHub<GitHubApiWorkflowRun>(`/repos/${repoPath}/actions/runs/${runId}`, auth.token);
    try {
      const jobs = await requestGitHub<{ jobs?: GitHubApiWorkflowJob[] }>(
        `/repos/${repoPath}/actions/runs/${runId}/jobs?filter=all&per_page=100`, auth.token
      );
      return {
        checkedAt: new Date().toISOString(),
        jobs: (jobs.jobs ?? []).map((job, index) => mapWorkflowJob(job, index + 1)),
        run: mapWorkflowRun(run),
        status: 'connected'
      };
    } catch {
      return {
        checkedAt: new Date().toISOString(), jobs: [],
        message: 'Workflow run loaded, but jobs are temporarily unavailable.',
        partial: true, run: mapWorkflowRun(run), status: 'connected'
      };
    }
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(), jobs: [],
      message: error instanceof GitHubRequestError && error.rateLimited
        ? 'GitHub rate limited the workflow request. Try again later.'
        : 'Could not load workflow run details.',
      status: error instanceof GitHubRequestError && error.rateLimited ? 'rate-limited' : 'error'
    };
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
      scope: 'repo read:user codespace'
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
