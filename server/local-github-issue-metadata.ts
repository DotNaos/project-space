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

export interface LocalGitHubIssueMetadataResult {
  fullName: string;
  labels: LocalGitHubIssueLabel[];
  message?: string;
  status: 'connected' | 'auth-required' | 'not-configured' | 'error';
}

interface GitHubApiLabel {
  color: string;
  description: string | null;
  name: string;
}

interface GitHubIssueMetadataDependencies {
  getGitHubClientId(): string;
  requestGitHub<T>(path: string, token: string): Promise<T>;
  resolveOAuthToken(): Promise<{ token: string } | null>;
}

const defaultDependencies: GitHubIssueMetadataDependencies = {
  getGitHubClientId,
  requestGitHub,
  resolveOAuthToken
};
const labelsPerPage = 100;

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
    let page = 1;

    for (;;) {
      const response = await dependencies.requestGitHub<GitHubApiLabel[]>(
        `/repos/${repoPath}/labels?per_page=${labelsPerPage}&page=${page}`,
        auth.token
      );
      labels.push(...response.map((label) => ({
        color: label.color,
        description: label.description ?? undefined,
        name: label.name
      })));

      if (response.length < labelsPerPage) break;
      page += 1;
    }

    return { fullName, labels, status: 'connected' };
  } catch (error) {
    return {
      fullName,
      labels: [],
      message: error instanceof Error ? error.message : 'Could not load repository labels.',
      status: 'error'
    };
  }
}
