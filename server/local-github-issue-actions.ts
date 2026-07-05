import type {
  GitHubBranchCreateRequest,
  GitHubBranchMutationResult,
  GitHubCatalogResult,
  GitHubIssueCommentCreateRequest,
  GitHubIssueCommentMutationResult,
  GitHubIssueCommentRecord,
  GitHubIssueCommentsResult
} from '../src/shared/project-space-api';
import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  requestGitHub,
  resolveToken
} from './local-github-catalog';

interface GitHubApiRepository {
  default_branch?: string;
  html_url: string;
}

interface GitHubApiGitRef {
  object?: {
    sha?: string;
  };
}

interface GitHubApiIssueComment {
  body?: string | null;
  created_at?: string | null;
  html_url: string;
  id: number;
  updated_at?: string | null;
  user?: {
    login?: string;
  } | null;
}

function repoApiPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function mapGitHubComment(comment: GitHubApiIssueComment): GitHubIssueCommentRecord {
  return {
    author: comment.user?.login,
    body: comment.body ?? '',
    createdAt: comment.created_at ?? undefined,
    id: comment.id,
    updatedAt: comment.updated_at ?? undefined,
    url: comment.html_url
  };
}

function branchMutationError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubBranchMutationResult {
  return { message, status };
}

function commentsError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubIssueCommentsResult {
  return { comments: [], message, status };
}

function commentMutationError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubIssueCommentMutationResult {
  return { message, status };
}

export async function createGitHubBranch({
  fullName,
  name,
  sourceBranch
}: GitHubBranchCreateRequest): Promise<GitHubBranchMutationResult> {
  const auth = await resolveToken();

  if (!auth) {
    return branchMutationError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId() ? 'Connect GitHub to create branches.' : githubOAuthClientIdMissingMessage
    );
  }

  const branchName = name.trim();

  if (!branchName) {
    return branchMutationError('error', 'Branch name is required.');
  }

  try {
    const repoPath = repoApiPath(fullName);
    const repo = await requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token);
    const baseBranch = sourceBranch?.trim() || repo.default_branch || 'main';
    const encodedBaseBranch = encodeURIComponent(baseBranch).replace(/%2F/g, '/');
    const sourceRef = await requestGitHub<GitHubApiGitRef>(
      `/repos/${repoPath}/git/ref/heads/${encodedBaseBranch}`,
      auth.token
    );
    const sha = sourceRef.object?.sha;

    if (!sha) {
      return branchMutationError('error', `Could not resolve ${baseBranch}.`);
    }

    await requestGitHub<GitHubApiGitRef>(`/repos/${repoPath}/git/refs`, auth.token, {
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST'
    });

    return {
      branch: {
        isDefault: branchName === repo.default_branch,
        name: branchName,
        url: `${repo.html_url}/tree/${encodeURIComponent(branchName).replace(/%2F/g, '/')}`
      },
      status: 'connected'
    };
  } catch (error) {
    return branchMutationError(
      'error',
      error instanceof Error ? error.message : 'Could not create GitHub branch.'
    );
  }
}

export async function getGitHubIssueComments(
  fullName: string,
  number: number
): Promise<GitHubIssueCommentsResult> {
  const auth = await resolveToken();

  if (!auth) {
    return commentsError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId() ? 'Connect GitHub to load comments.' : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const comments = await requestGitHub<GitHubApiIssueComment[]>(
      `/repos/${repoApiPath(fullName)}/issues/${number}/comments?per_page=50`,
      auth.token
    );

    return {
      comments: comments.map(mapGitHubComment),
      status: 'connected'
    };
  } catch (error) {
    return commentsError(
      'error',
      error instanceof Error ? error.message : 'Could not load GitHub comments.'
    );
  }
}

export async function createGitHubIssueComment({
  body,
  fullName,
  number
}: GitHubIssueCommentCreateRequest): Promise<GitHubIssueCommentMutationResult> {
  const auth = await resolveToken();

  if (!auth) {
    return commentMutationError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId() ? 'Connect GitHub to comment on issues.' : githubOAuthClientIdMissingMessage
    );
  }

  const commentBody = body.trim();

  if (!commentBody) {
    return commentMutationError('error', 'Comment body is required.');
  }

  try {
    const comment = await requestGitHub<GitHubApiIssueComment>(
      `/repos/${repoApiPath(fullName)}/issues/${number}/comments`,
      auth.token,
      {
        body: JSON.stringify({ body: commentBody }),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST'
      }
    );

    return {
      comment: mapGitHubComment(comment),
      status: 'connected'
    };
  } catch (error) {
    return commentMutationError(
      'error',
      error instanceof Error ? error.message : 'Could not create GitHub comment.'
    );
  }
}
