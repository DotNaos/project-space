import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  GitHubAuthSource,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitHubProjectConfigStatus
} from '../src/shared/project-space-api';

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

interface TokenResolution {
  login?: string;
  source: GitHubAuthSource;
  token: string;
}

const projectSpaceDirectory = join(homedir(), '.project-space');
const githubTokenFile = join(projectSpaceDirectory, 'github-oauth.json');
const githubApiBaseUrl = 'https://api.github.com';
const githubDeviceCodeUrl = 'https://github.com/login/device/code';
const githubAccessTokenUrl = 'https://github.com/login/oauth/access_token';

function getGitHubClientId() {
  return process.env.PROJECT_SPACE_GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? '';
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

async function requestGitHub<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${githubApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}.`);
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

async function resolveToken(): Promise<TokenResolution | null> {
  const stored = readStoredToken();

  if (stored) {
    return {
      login: stored.login,
      source: 'stored-oauth',
      token: stored.accessToken
    };
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

async function listRepositories(token: string) {
  return requestGitHub<GitHubApiRepository[]>(
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100',
    token
  );
}

async function fileExists(repo: GitHubApiRepository, fileName: string, token: string) {
  const branch = repo.default_branch ? `?ref=${encodeURIComponent(repo.default_branch)}` : '';
  const response = await fetch(
    `${githubApiBaseUrl}/repos/${repo.full_name}/contents/${fileName}${branch}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );

  if (response.status === 404 || response.status === 409) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`GitHub contents request failed with ${response.status}.`);
  }

  return true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
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

function projectConfigStatus(
  projectYaml: boolean,
  templateLock: boolean
): GitHubProjectConfigStatus {
  if (projectYaml && templateLock) {
    return 'complete';
  }

  if (projectYaml || templateLock) {
    return 'partial';
  }

  return 'missing';
}

async function toCatalogRepository(
  repo: GitHubApiRepository,
  token: string
): Promise<GitHubCatalogRepository> {
  let projectYaml = false;
  let templateLock = false;
  let status: GitHubProjectConfigStatus = 'missing';

  try {
    [projectYaml, templateLock] = await Promise.all([
      fileExists(repo, 'project.yaml', token),
      fileExists(repo, 'template.lock.yaml', token)
    ]);
    status = projectConfigStatus(projectYaml, templateLock);
  } catch {
    status = 'unknown';
  }

  return {
    defaultBranch: repo.default_branch,
    description: repo.description ?? undefined,
    fullName: repo.full_name,
    id: repo.id,
    isPrivate: repo.private,
    name: repo.name,
    owner: repo.owner.login,
    projectConfig: {
      projectYaml,
      status,
      templateLock
    },
    pushedAt: repo.pushed_at ?? undefined,
    updatedAt: repo.updated_at ?? undefined,
    url: repo.html_url
  };
}

export async function getGitHubCatalog(): Promise<GitHubCatalogResult> {
  const auth = await resolveToken();

  if (!auth) {
    return createEmptyCatalog(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId()
        ? 'Connect GitHub to load the remote project catalog.'
        : 'Set PROJECT_SPACE_GITHUB_CLIENT_ID to enable GitHub OAuth.'
    );
  }

  try {
    const repositories = await mapWithConcurrency(
      await listRepositories(auth.token),
      6,
      (repo) => toCatalogRepository(repo, auth.token)
    );

    return {
      auth: {
        login: auth.login,
        source: auth.source
      },
      checkedAt: new Date().toISOString(),
      repositories,
      status: 'connected'
    };
  } catch (error) {
    return createEmptyCatalog(
      'error',
      error instanceof Error ? error.message : 'Could not load GitHub repositories.'
    );
  }
}

export async function startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult> {
  const clientId = getGitHubClientId();

  if (!clientId) {
    return {
      message: 'Set PROJECT_SPACE_GITHUB_CLIENT_ID to enable GitHub OAuth.',
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
      message: 'Set PROJECT_SPACE_GITHUB_CLIENT_ID to enable GitHub OAuth.',
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

  writeStoredToken({
    accessToken: payload.access_token,
    createdAt: new Date().toISOString(),
    login,
    scope: payload.scope,
    tokenType: payload.token_type
  });

  return {
    catalog: await getGitHubCatalog(),
    status: 'connected'
  };
}
