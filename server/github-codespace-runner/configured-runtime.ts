import type {
  GitHubCodespaceRunnerRequest,
  GitHubCodespaceRunnerResult
} from '../../src/shared/github-codespace-runner-api';
import { GITHUB_CODESPACE_RUNNER_API_VERSION } from '../../src/shared/github-codespace-runner-api';
import type {
  GitHubCodespaceInventoryItem,
  GitHubCodespaceInventoryResult
} from '../../src/shared/github-codespace-inventory-api';
import { GITHUB_CODESPACE_INVENTORY_API_VERSION } from '../../src/shared/github-codespace-inventory-api';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from '../local-auth-store';
import { getMachineConnectionDatabaseClient, listComputeInventory } from '../local-database-store';
import {
  GitHubRequestError,
  requestGitHub,
  resolveOAuthToken,
  type TokenResolution
} from '../local-github-catalog';
import { readMachineConnectionPublicOrigin } from '../machine-connection-environment';
import {
  createGitHubCodespaceRunnerService,
  type GitHubCodespaceRecord
} from './service';
import { createGitHubCodespaceApprovalLookup } from './approval-lookup';

export interface GitHubCodespaceRunnerRuntime {
  run(request: GitHubCodespaceRunnerRequest): Promise<GitHubCodespaceRunnerResult>;
}

export interface GitHubCodespaceInventoryRuntime {
  listInventory(): Promise<GitHubCodespaceInventoryResult>;
}

export type ConfiguredGitHubCodespaceRuntime =
  GitHubCodespaceRunnerRuntime & GitHubCodespaceInventoryRuntime;

export interface GitHubCodespaceRunnerRuntimeDependencies {
  authRequired(): boolean;
  createService(input: {
    token: string;
    userId: string;
  }): GitHubCodespaceRunnerRuntime;
  currentUserId(): string | undefined;
  listCodespaces(token: string): Promise<GitHubCodespaceRecord[]>;
  now?(): Date;
  resolveOAuthToken(): Promise<TokenResolution | null>;
  serialize<Result>(
    request: GitHubCodespaceRunnerRequest,
    operation: () => Promise<Result>
  ): Promise<Result>;
}

export class GitHubCodespaceRunnerAuthenticationError extends Error {}
export class GitHubCodespaceInventoryUnavailableError extends Error {}

export function createGitHubCodespaceRunnerRuntime(
  dependencies: GitHubCodespaceRunnerRuntimeDependencies
): ConfiguredGitHubCodespaceRuntime {
  const now = dependencies.now ?? (() => new Date());

  return {
    async listInventory() {
      const userId = currentUserId(dependencies);
      if (!userId) throw new GitHubCodespaceRunnerAuthenticationError('Login required.');

      const auth = await dependencies.resolveOAuthToken();
      if (!auth) return inventoryResult(now(), 'not_connected');
      if (auth.source === 'stored-oauth' && !scopeIncludes(auth.scope, 'codespace')) {
        return inventoryResult(now(), 'scope_insufficient');
      }

      try {
        const codespaces = await dependencies.listCodespaces(auth.token);
        return inventoryResult(now(), 'connected', codespaces.map(inventoryItem));
      } catch (error) {
        if (error instanceof GitHubRequestError && error.statusCode === 401) {
          return inventoryResult(now(), 'not_connected');
        }
        if (error instanceof GitHubRequestError && error.statusCode === 403 && !error.rateLimited) {
          return inventoryResult(now(), 'scope_insufficient');
        }
        throw new GitHubCodespaceInventoryUnavailableError();
      }
    },
    async run(request) {
      const userId = currentUserId(dependencies);
      if (!userId) throw new GitHubCodespaceRunnerAuthenticationError('Login required.');

      try {
        const auth = await dependencies.resolveOAuthToken();
        if (!auth) {
          return unavailable(
            request,
            'github-reauthorization-required',
            'Connect GitHub before creating a Codespace.'
          );
        }
        if (auth.source === 'stored-oauth' && !scopeIncludes(auth.scope, 'codespace')) {
          return unavailable(
            request,
            'github-reauthorization-required',
            'Reconnect GitHub once to grant Codespaces access.'
          );
        }

        const operation = () => dependencies.createService({
          token: auth.token,
          userId
        }).run(request);
        return request.action === 'status'
          ? await operation()
          : await dependencies.serialize(request, operation);
      } catch (error) {
        const state = error instanceof GitHubRequestError && error.statusCode === 403
          ? 'github-reauthorization-required'
          : 'failed';
        const message = error instanceof GitHubRequestError && error.rateLimited
          ? 'GitHub rate limited the Codespaces request. Try again shortly.'
          : error instanceof Error ? error.message : 'The Codespaces request failed safely.';
        return unavailable(request, state, message);
      }
    }
  };
}

export function createConfiguredGitHubCodespaceRunnerRuntime(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
}): ConfiguredGitHubCodespaceRuntime {
  return createGitHubCodespaceRunnerRuntime({
    authRequired: isProjectSpaceAuthRequired,
    createService: ({ token, userId }) => createGitHubCodespaceRunnerService({
      create: (input) => createCodespace(token, input),
      delete: async (name) => {
        await requestGitHub(`/user/codespaces/${encodeURIComponent(name)}`, token, {
          method: 'DELETE'
        });
      },
      findApproval,
      async inventory() {
        return {
          compute: await listComputeInventory(userId),
          connectors: (await options.backend.getConnectorOverview()).machines
        };
      },
      list: () => listCodespaces(token),
      start: (name) => mutateCodespace(token, name, 'start'),
      stop: (name) => mutateCodespace(token, name, 'stop')
    }),
    currentUserId: () => getCurrentAuthSession()?.userId,
    listCodespaces,
    resolveOAuthToken,
    serialize: runSerialized
  });
}

function currentUserId(dependencies: GitHubCodespaceRunnerRuntimeDependencies) {
  return dependencies.currentUserId() ?? (
    dependencies.authRequired() ? undefined : 'local-development-user'
  );
}

function inventoryResult(
  checkedAt: Date,
  connectionState: GitHubCodespaceInventoryResult['provider']['connectionState'],
  codespaces: GitHubCodespaceInventoryItem[] = []
): GitHubCodespaceInventoryResult {
  return {
    apiVersion: GITHUB_CODESPACE_INVENTORY_API_VERSION,
    checkedAt: checkedAt.toISOString(),
    codespaces,
    provider: { connectionState, source: 'github_api' }
  };
}

function inventoryItem(codespace: GitHubCodespaceRecord): GitHubCodespaceInventoryItem {
  return {
    createdAt: codespace.createdAt,
    ...(codespace.displayName ? { displayName: codespace.displayName } : {}),
    name: codespace.name,
    ...(codespace.ref ? { ref: codespace.ref } : {}),
    repositoryFullName: codespace.repositoryFullName,
    state: codespace.state,
    ...(codespace.url ? { url: codespace.url } : {})
  };
}

const findApproval = createGitHubCodespaceApprovalLookup({
  database: getMachineConnectionDatabaseClient,
  publicOrigin: () => readMachineConnectionPublicOrigin(process.env)
});

interface GitHubApiCodespace {
  created_at?: unknown;
  display_name?: unknown;
  git_status?: unknown;
  name?: unknown;
  repository?: unknown;
  state?: unknown;
  web_url?: unknown;
}

interface GitHubCodespaceDefaultsResponse {
  defaults?: {
    location?: string;
  };
}

export async function listCodespaces(
  token: string,
  request: typeof requestGitHub = requestGitHub
) {
  const codespaces: GitHubApiCodespace[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await request<{ codespaces?: unknown }>(
      `/user/codespaces?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(payload.codespaces)) {
      throw new Error('GitHub returned an invalid Codespace inventory page.');
    }
    codespaces.push(...payload.codespaces as GitHubApiCodespace[]);
    if (payload.codespaces.length < 100) break;
    if (page === 10) throw new Error('GitHub Codespace inventory exceeded its safe page bound.');
  }
  const result = codespaces.map(mapCodespace);
  if (new Set(result.map(({ name }) => name)).size !== result.length) {
    throw new Error('GitHub returned duplicate Codespace identities.');
  }
  return result;
}

async function createCodespace(
  token: string,
  input: { branch: string; displayName: string; repositoryFullName: string }
) {
  const [owner, repository] = input.repositoryFullName.split('/');
  const repositoryPath = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}`;
  const recommendedLocation = await resolveRecommendedCodespaceLocation(
    token,
    repositoryPath,
    input.branch
  );
  return mapCodespace(await requestGitHub<GitHubApiCodespace>(
    `${repositoryPath}/codespaces`,
    token,
    {
      body: JSON.stringify(githubCodespaceCreateBody(input, recommendedLocation)),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    }
  ));
}

async function resolveRecommendedCodespaceLocation(
  token: string,
  repositoryPath: string,
  branch: string
) {
  try {
    const response = await requestGitHub<GitHubCodespaceDefaultsResponse>(
      `${repositoryPath}/codespaces/new?ref=${encodeURIComponent(branch)}`,
      token
    );
    return response.defaults?.location;
  } catch {
    return undefined;
  }
}

export function githubCodespaceCreateBody(
  input: { branch: string; displayName: string },
  recommendedLocation?: string
) {
  const location = githubCodespaceCreateLocation(recommendedLocation);
  return {
    devcontainer_path: '.devcontainer/devcontainer.json',
    display_name: input.displayName,
    idle_timeout_minutes: 30,
    ...(location ? { location } : {}),
    ref: input.branch,
    retention_period_minutes: 4_320
  };
}

export function githubCodespaceCreateLocation(recommendedLocation?: string) {
  const location = recommendedLocation === 'EuropeWest'
    ? 'WestEurope'
    : recommendedLocation;
  return ['EastUs', 'SouthEastAsia', 'WestEurope', 'WestUs2'].includes(location ?? '')
    ? location
    : 'WestEurope';
}

async function mutateCodespace(token: string, name: string, action: 'start' | 'stop') {
  return mapCodespace(await requestGitHub<GitHubApiCodespace>(
    `/user/codespaces/${encodeURIComponent(name)}/${action}`,
    token,
    { method: 'POST' }
  ));
}

function mapCodespace(value: GitHubApiCodespace): GitHubCodespaceRecord {
  const repository = isRecord(value.repository) ? value.repository : {};
  const gitStatus = isRecord(value.git_status) ? value.git_status : {};
  const name = boundedToken(value.name, /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/);
  const repositoryFullName = boundedToken(
    repository.full_name,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    256
  );
  const state = boundedProviderText(value.state, 100);
  const createdAt = safeTimestamp(value.created_at);
  if (!name || !repositoryFullName || !state || !createdAt) {
    throw new Error('GitHub returned an invalid Codespace record.');
  }
  const displayName = boundedProviderText(value.display_name, 128);
  const ref = boundedProviderText(gitStatus.ref, 255);
  const url = safeGitHubUrl(value.web_url);
  return {
    createdAt,
    ...(displayName ? { displayName } : {}),
    name,
    ...(ref ? { ref } : {}),
    repositoryFullName,
    state,
    ...(url ? { url } : {})
  };
}

function boundedProviderText(value: unknown, maximum: number) {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return sanitized ? sanitized.slice(0, maximum) : undefined;
}

function boundedToken(value: unknown, pattern: RegExp, maximum = 128) {
  return typeof value === 'string' && value.length <= maximum && pattern.test(value)
    ? value
    : undefined;
}

function safeTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function safeGitHubUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === 'github.com' || url.hostname.endsWith('.github.com'))) {
      return undefined;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runSerialized<Result>(
  request: GitHubCodespaceRunnerRequest,
  operation: () => Promise<Result>
) {
  const client = await getMachineConnectionDatabaseClient();
  const scope = `${request.repositoryFullName.toLowerCase()}:${request.issue}:${request.branch}`;
  return client.transaction(async (transaction) => {
    await transaction.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
    return operation();
  });
}

function scopeIncludes(scope: string | undefined, expected: string) {
  return (scope ?? '').split(/[ ,]+/).includes(expected);
}

function unavailable(
  request: GitHubCodespaceRunnerRequest,
  state: 'failed' | 'github-reauthorization-required',
  message: string
): GitHubCodespaceRunnerResult {
  return {
    apiVersion: GITHUB_CODESPACE_RUNNER_API_VERSION,
    message,
    operationId: request.operationId,
    state
  };
}
