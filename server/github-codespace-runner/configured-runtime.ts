import type {
  GitHubCodespaceRunnerRequest,
  GitHubCodespaceRunnerResult
} from '../../src/shared/github-codespace-runner-api';
import { GITHUB_CODESPACE_RUNNER_API_VERSION } from '../../src/shared/github-codespace-runner-api';
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

export interface GitHubCodespaceRunnerRuntimeDependencies {
  authRequired(): boolean;
  createService(input: {
    token: string;
    userId: string;
  }): GitHubCodespaceRunnerRuntime;
  currentUserId(): string | undefined;
  resolveOAuthToken(): Promise<TokenResolution | null>;
  serialize<Result>(
    request: GitHubCodespaceRunnerRequest,
    operation: () => Promise<Result>
  ): Promise<Result>;
}

export class GitHubCodespaceRunnerAuthenticationError extends Error {}

export function createGitHubCodespaceRunnerRuntime(
  dependencies: GitHubCodespaceRunnerRuntimeDependencies
): GitHubCodespaceRunnerRuntime {
  return {
    async run(request) {
      const userId = dependencies.currentUserId() ?? (
        dependencies.authRequired() ? undefined : 'local-development-user'
      );
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
}): GitHubCodespaceRunnerRuntime {
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
    resolveOAuthToken,
    serialize: runSerialized
  });
}

const findApproval = createGitHubCodespaceApprovalLookup({
  database: getMachineConnectionDatabaseClient,
  publicOrigin: () => readMachineConnectionPublicOrigin(process.env)
});

interface GitHubApiCodespace {
  created_at: string;
  display_name?: string;
  git_status?: { ref?: string };
  name: string;
  repository: { full_name: string };
  state: string;
  web_url?: string;
}

interface GitHubCodespaceDefaultsResponse {
  defaults?: {
    location?: string;
  };
}

async function listCodespaces(token: string) {
  const codespaces: GitHubApiCodespace[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await requestGitHub<{ codespaces: GitHubApiCodespace[] }>(
      `/user/codespaces?per_page=100&page=${page}`,
      token
    );
    codespaces.push(...payload.codespaces);
    if (payload.codespaces.length < 100) break;
  }
  return codespaces.map(mapCodespace);
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
    : undefined;
}

async function mutateCodespace(token: string, name: string, action: 'start' | 'stop') {
  return mapCodespace(await requestGitHub<GitHubApiCodespace>(
    `/user/codespaces/${encodeURIComponent(name)}/${action}`,
    token,
    { method: 'POST' }
  ));
}

function mapCodespace(value: GitHubApiCodespace): GitHubCodespaceRecord {
  return {
    createdAt: value.created_at,
    displayName: value.display_name,
    name: value.name,
    repositoryFullName: value.repository.full_name,
    state: value.state,
    url: value.web_url,
    ref: value.git_status?.ref
  };
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
