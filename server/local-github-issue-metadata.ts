import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  requestGitHub,
  resolveOAuthToken
} from './local-github-catalog';

export interface LocalGitHubIssueLabel {
  color: string;
  description?: string;
  name: string;
}

export type GitHubIssueWriteCapability = 'denied' | 'unverified';

export interface LocalGitHubIssueMetadataResult {
  attachmentStorage?: 'per-issue-branch';
  attachmentWrite?: GitHubIssueWriteCapability;
  fullName: string;
  labelWrite?: GitHubIssueWriteCapability;
  labels: LocalGitHubIssueLabel[];
  message?: string;
  status: 'connected' | 'auth-required' | 'not-configured' | 'error';
}

interface GitHubIssueMetadataDependencies {
  getGitHubClientId(): string;
  requestGitHub<T>(path: string, token: string): Promise<T>;
  resolveOAuthToken(): Promise<{ token: string } | null>;
}

interface GitHubRepositoryPermissionsResponse {
  archived?: unknown;
  disabled?: unknown;
  permissions?: { push?: unknown };
}

const defaultDependencies: GitHubIssueMetadataDependencies = {
  getGitHubClientId,
  requestGitHub,
  resolveOAuthToken
};
const labelsPerPage = 100;
const maximumLabelPages = 100;

function repositoryApiPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

export function isValidGitHubRepositoryFullName(fullName: string) {
  if (fullName.length > 140) return false;

  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false;
  if (repository === '.' || repository === '..' || repository.length > 100) return false;

  return /^[A-Za-z0-9._-]+$/.test(repository);
}

function sanitizedLabel(value: unknown): LocalGitHubIssueLabel | null {
  if (!value || typeof value !== 'object') return null;

  const label = value as { color?: unknown; description?: unknown; name?: unknown };
  const name = typeof label.name === 'string' ? label.name.trim() : '';
  const color = typeof label.color === 'string' ? label.color.trim().toLowerCase() : '';

  if (!name || name.length > 50 || !/^[0-9a-f]{6}$/.test(color)) {
    return null;
  }

  const description =
    typeof label.description === 'string' ? label.description.trim().slice(0, 100) : '';

  return {
    color,
    description: description || undefined,
    name
  };
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return 'Could not load repository labels.';
  }

  return error.message.slice(0, 300) || 'Could not load repository labels.';
}

function repositoryWriteCapability(
  repository: GitHubRepositoryPermissionsResponse
): GitHubIssueWriteCapability {
  return repository.archived === true
    || repository.disabled === true
    || repository.permissions?.push === false
    ? 'denied'
    : 'unverified';
}

function repositoryLabelWriteCapability(
  repository: GitHubRepositoryPermissionsResponse
): GitHubIssueWriteCapability {
  return repository.archived === true || repository.disabled === true
    ? 'denied'
    : 'unverified';
}

export async function loadLocalGitHubIssueMetadata(
  fullName: string,
  dependencies: GitHubIssueMetadataDependencies = defaultDependencies
): Promise<LocalGitHubIssueMetadataResult> {
  if (!isValidGitHubRepositoryFullName(fullName)) {
    return {
      fullName,
      labels: [],
      message: 'Repository name must include a valid owner and name.',
      status: 'error'
    };
  }

  const auth = await dependencies.resolveOAuthToken();
  if (!auth) {
    const configured = Boolean(dependencies.getGitHubClientId());

    return {
      fullName,
      labels: [],
      message: configured
        ? 'Connect GitHub to load repository labels.'
        : githubOAuthClientIdMissingMessage,
      status: configured ? 'auth-required' : 'not-configured'
    };
  }

  try {
    const labels: LocalGitHubIssueLabel[] = [];
    const repoPath = repositoryApiPath(fullName);
    const repository = await dependencies.requestGitHub<GitHubRepositoryPermissionsResponse>(
      `/repos/${repoPath}`,
      auth.token
    );
    if (!repository || typeof repository !== 'object') {
      throw new Error('GitHub returned invalid repository permissions.');
    }
    const attachmentWrite = repositoryWriteCapability(repository);
    const labelWrite = repositoryLabelWriteCapability(repository);

    for (let page = 1; page <= maximumLabelPages; page += 1) {
      const response = await dependencies.requestGitHub<unknown>(
        `/repos/${repoPath}/labels?per_page=${labelsPerPage}&page=${page}`,
        auth.token
      );

      if (!Array.isArray(response)) {
        throw new Error('GitHub returned invalid repository labels.');
      }

      labels.push(
        ...response
          .map(sanitizedLabel)
          .filter((label): label is LocalGitHubIssueLabel => Boolean(label))
      );

      if (response.length < labelsPerPage) {
        return {
          attachmentStorage: 'per-issue-branch',
          attachmentWrite,
          fullName,
          labels,
          labelWrite,
          status: 'connected'
        };
      }
    }

    return {
      fullName,
      labels: [],
      message: 'This repository has too many labels to load safely.',
      status: 'error'
    };
  } catch (error) {
    return {
      fullName,
      labels: [],
      message: safeErrorMessage(error),
      status: 'error'
    };
  }
}
