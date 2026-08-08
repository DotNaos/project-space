import {
  GitHubRequestError,
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  requestGitHub,
  resolveToken
} from './local-github-catalog';
import {
  githubRepositoryFileMaximumBytes,
  type GitHubRepositoryFileResult,
  type GitHubRepositoryTreeResult,
  type GitHubTreeEntry
} from '../src/shared/github-repository-tree';

interface GitHubApiTreeEntry {
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
}

interface GitHubApiTree {
  sha?: string;
  tree?: GitHubApiTreeEntry[];
  truncated?: boolean;
}

interface GitHubApiContent {
  content?: string;
  encoding?: string;
  size?: number;
  type?: string;
}

function repositoryPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function unauthenticatedReason() {
  return getGitHubClientId()
    ? { message: 'Connect GitHub to read this repository.', status: 'auth-required' as const }
    : { message: githubOAuthClientIdMissingMessage, status: 'not-configured' as const };
}

function failureMessage(error: unknown) {
  if (error instanceof GitHubRequestError) {
    return error.rateLimited
      ? 'GitHub rate limit reached. Try again shortly.'
      : error.message;
  }
  return error instanceof Error ? error.message : 'The GitHub request failed.';
}

export async function getGitHubRepositoryTree(
  fullName: string,
  ref: string
): Promise<GitHubRepositoryTreeResult> {
  const auth = await resolveToken();
  const checkedAt = new Date().toISOString();
  if (!auth) {
    const reason = unauthenticatedReason();
    return { checkedAt, entries: [], message: reason.message, ref, status: reason.status, truncated: false };
  }

  try {
    const tree = await requestGitHub<GitHubApiTree>(
      `/repos/${repositoryPath(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      auth.token
    );
    const entries = (tree.tree ?? []).flatMap<GitHubTreeEntry>((entry) => {
      if (!entry.path || !entry.sha) return [];
      if (entry.type !== 'blob' && entry.type !== 'tree') return [];
      return [{
        path: entry.path,
        sha: entry.sha,
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
        type: entry.type
      }];
    });
    return {
      checkedAt,
      entries,
      ref,
      status: 'connected',
      truncated: tree.truncated === true
    };
  } catch (error) {
    return {
      checkedAt,
      entries: [],
      message: failureMessage(error),
      ref,
      status: 'error',
      truncated: false
    };
  }
}

export async function getGitHubRepositoryFile(
  fullName: string,
  ref: string,
  path: string
): Promise<GitHubRepositoryFileResult> {
  const auth = await resolveToken();
  if (!auth) {
    const reason = unauthenticatedReason();
    return { encoding: 'none', message: reason.message, path, ref, size: 0, status: reason.status };
  }

  try {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const content = await requestGitHub<GitHubApiContent>(
      `/repos/${repositoryPath(fullName)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      auth.token
    );
    const size = typeof content.size === 'number' ? content.size : 0;
    if (content.type !== 'file') {
      return {
        encoding: 'none',
        message: 'This path is not a file.',
        path,
        ref,
        size,
        status: 'error'
      };
    }
    if (size > githubRepositoryFileMaximumBytes) {
      return {
        encoding: 'none',
        message: 'This file is too large to show here.',
        path,
        ref,
        size,
        status: 'connected'
      };
    }
    if (content.encoding !== 'base64' || typeof content.content !== 'string') {
      return {
        encoding: 'none',
        message: 'This file is not available as text.',
        path,
        ref,
        size,
        status: 'connected'
      };
    }

    const decoded = Buffer.from(content.content, 'base64');
    // A NUL byte is the cheapest reliable signal that this is not source text.
    if (decoded.includes(0)) {
      return {
        encoding: 'none',
        message: 'This file is binary.',
        path,
        ref,
        size,
        status: 'connected'
      };
    }
    return {
      content: decoded.toString('utf8'),
      encoding: 'utf-8',
      path,
      ref,
      size,
      status: 'connected'
    };
  } catch (error) {
    return {
      encoding: 'none',
      message: failureMessage(error),
      path,
      ref,
      size: 0,
      status: 'error'
    };
  }
}
