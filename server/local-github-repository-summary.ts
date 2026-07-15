import type { GitHubRepositorySummaryResult } from '../src/shared/github-repository-summary';
import { isValidGitHubRepositoryFullName } from '../src/shared/github-repository-summary';
import { requestGitHubGraphQL } from './github-graphql-client';
import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  resolveToken
} from './local-github-catalog';

interface GitHubRepositorySummaryDependencies {
  getGitHubClientId(): string;
  requestGraphQL<T>(
    token: string,
    query: string,
    variables: Record<string, unknown>
  ): Promise<T>;
  resolveToken(): Promise<{ token: string } | null>;
}

interface GitHubRepositorySummaryGraphQL {
  repository?: {
    issues?: { totalCount?: unknown } | null;
    refs?: { totalCount?: unknown } | null;
  } | null;
}

const repositorySummaryQuery = `
  query ProjectSpaceRepositorySummary($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: "refs/heads/", first: 1) { totalCount }
      issues(states: OPEN, first: 1) { totalCount }
    }
  }
`;

const defaultDependencies: GitHubRepositorySummaryDependencies = {
  getGitHubClientId,
  requestGraphQL: requestGitHubGraphQL,
  resolveToken
};

function failure(
  fullName: string,
  status: 'auth-required' | 'error' | 'not-configured',
  message: string
): GitHubRepositorySummaryResult {
  return {
    checkedAt: new Date().toISOString(),
    fullName,
    message,
    status
  };
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Could not load repository counts.';
  return error.message.slice(0, 300) || 'Could not load repository counts.';
}

export async function loadLocalGitHubRepositorySummary(
  fullName: string,
  dependencies: GitHubRepositorySummaryDependencies = defaultDependencies
): Promise<GitHubRepositorySummaryResult> {
  if (!isValidGitHubRepositoryFullName(fullName)) {
    return failure(fullName, 'error', 'Repository name must include a valid owner and name.');
  }

  const auth = await dependencies.resolveToken();
  if (!auth) {
    const configured = Boolean(dependencies.getGitHubClientId());
    return failure(
      fullName,
      configured ? 'auth-required' : 'not-configured',
      configured
        ? 'Connect GitHub to load repository counts.'
        : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const [owner, name] = fullName.split('/');
    const data = await dependencies.requestGraphQL<GitHubRepositorySummaryGraphQL>(
      auth.token,
      repositorySummaryQuery,
      { name, owner }
    );
    if (!data.repository) {
      throw new Error('GitHub could not find this repository.');
    }
    const branchCount = data.repository.refs === null
      ? 0
      : count(data.repository.refs?.totalCount);
    const openIssueCount = count(data.repository.issues?.totalCount);
    if (branchCount === undefined || openIssueCount === undefined) {
      throw new Error('GitHub returned invalid repository counts.');
    }

    return {
      branchCount,
      checkedAt: new Date().toISOString(),
      fullName,
      openIssueCount,
      status: 'connected'
    };
  } catch (error) {
    return failure(fullName, 'error', safeErrorMessage(error));
  }
}
