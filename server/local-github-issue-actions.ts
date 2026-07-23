import type {
  GitHubBranchCreateRequest,
  GitHubBranchDeleteRequest,
  GitHubBranchMutationResult,
  GitHubCatalogResult,
  GitHubIssueCreateRequest,
  GitHubIssueCommentCreateRequest,
  GitHubIssueCommentMutationResult,
  GitHubIssueCommentRecord,
  GitHubIssueCommentsResult,
  GitHubIssueCreationResult,
  GitHubIssueMutationResult,
  GitHubIssueRecord,
  GitHubIssueUpdateRequest,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestMutationResult,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import { preserveGitHubIssueCreationMarker } from '../src/shared/github-issue-creation-marker';
import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  requestGitHub,
  resolveOAuthToken,
  resolveToken
} from './local-github-catalog';
import { requestGitHubGraphQL } from './github-graphql-client';
import { getCurrentAuthSession } from './local-auth-store';
import { createIdempotentGitHubIssue } from './github-issue-creation-service';
import { getGitHubIssueCreationOperationStore } from './github-issue-creation-store-provider';
import {
  createLocalGitHubIssueCreationRemote,
  mapLocalGitHubIssue,
  type LocalGitHubApiIssue
} from './local-github-issue-creation-remote';

interface GitHubApiRepository {
  default_branch?: string;
  html_url: string;
}

interface GitHubApiGitRef {
  object?: {
    sha?: string;
  };
}

interface GitHubLinkedBranchTarget {
  repository?: {
    issue?: {
      id: string;
    } | null;
  } | null;
}

interface GitHubCreateLinkedBranchResult {
  createLinkedBranch?: {
    linkedBranch?: {
      ref?: {
        name?: string;
        target?: {
          oid?: string;
        } | null;
      } | null;
    } | null;
  } | null;
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

interface GitHubApiPullRequest {
  body?: string | null;
  head?: {
    ref?: string | null;
    sha?: string | null;
  } | null;
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
  updated_at?: string | null;
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

export function mapGitHubPullRequest(
  pullRequest: GitHubApiPullRequest,
  linkedIssueNumber?: number
): GitHubPullRequestRecord {
  return {
    headBranch: pullRequest.head?.ref ?? undefined,
    headSha: pullRequest.head?.sha ?? undefined,
    linkedIssueNumbers: linkedIssueNumber ? [linkedIssueNumber] : [],
    number: pullRequest.number,
    state: pullRequest.state,
    title: pullRequest.title,
    updatedAt: pullRequest.updated_at ?? undefined,
    url: pullRequest.html_url
  };
}

function branchMutationError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubBranchMutationResult {
  return { message, status };
}

function issueMutationError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubIssueMutationResult {
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

function pullRequestMutationError(
  status: GitHubCatalogResult['status'],
  message?: string
): GitHubPullRequestMutationResult {
  return { message, status };
}

const createBranchDependencies = {
  requestGitHub,
  requestGitHubGraphQL,
  resolveOAuthToken
};

export function createGitHubBranch(request: GitHubBranchCreateRequest) {
  return createGitHubBranchWithDependencies(request, createBranchDependencies);
}

export async function createGitHubBranchWithDependencies({
  fullName,
  issueNumber,
  name,
  sourceBranch
}: GitHubBranchCreateRequest, dependencies: typeof createBranchDependencies): Promise<GitHubBranchMutationResult> {
  const auth = await dependencies.resolveOAuthToken();

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
    const repo = await dependencies.requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token);
    const baseBranch = sourceBranch?.trim() || repo.default_branch || 'main';
    const encodedBaseBranch = encodeURIComponent(baseBranch).replace(/%2F/g, '/');
    const sourceRef = await dependencies.requestGitHub<GitHubApiGitRef>(
      `/repos/${repoPath}/git/ref/heads/${encodedBaseBranch}`,
      auth.token
    );
    const sha = sourceRef.object?.sha;

    if (!sha) {
      return branchMutationError('error', `Could not resolve ${baseBranch}.`);
    }

    if (issueNumber) {
      const [owner, repoName] = fullName.split('/');

      if (!owner || !repoName) {
        return branchMutationError('error', 'Repository name must include owner and name.');
      }

      const target = await dependencies.requestGitHubGraphQL<GitHubLinkedBranchTarget>(
        auth.token,
        `
          query LinkedBranchTarget($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              issue(number: $number) {
                id
              }
            }
          }
        `,
        { name: repoName, number: issueNumber, owner }
      );
      const issueId = target.repository?.issue?.id;

      if (!issueId) {
        return branchMutationError('error', `Could not resolve issue #${issueNumber}.`);
      }

      const created = await dependencies.requestGitHubGraphQL<GitHubCreateLinkedBranchResult>(
        auth.token,
        `
          mutation CreateLinkedBranch($issueId: ID!, $name: String!, $oid: GitObjectID!) {
            createLinkedBranch(input: {issueId: $issueId, name: $name, oid: $oid}) {
              linkedBranch {
                ref {
                  name
                  target {
                    oid
                  }
                }
              }
            }
          }
        `,
        { issueId, name: branchName, oid: sha }
      );
      const linkedBranchName = created.createLinkedBranch?.linkedBranch?.ref?.name ?? branchName;
      const linkedCommitSha = created.createLinkedBranch?.linkedBranch?.ref?.target?.oid ?? sha;

      return {
        branch: {
          commitSha: linkedCommitSha,
          isDefault: linkedBranchName === repo.default_branch,
          linkedIssueNumbers: [issueNumber],
          name: linkedBranchName,
          url: `${repo.html_url}/tree/${encodeURIComponent(linkedBranchName).replace(/%2F/g, '/')}`
        },
        status: 'connected'
      };
    }

    const created = await dependencies.requestGitHub<GitHubApiGitRef>(`/repos/${repoPath}/git/refs`, auth.token, {
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
        commitSha: created.object?.sha ?? sha,
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

export async function deleteGitHubBranch({
  fullName,
  name
}: GitHubBranchDeleteRequest): Promise<GitHubBranchMutationResult> {
  const auth = await resolveOAuthToken();

  if (!auth) {
    return branchMutationError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId() ? 'Connect GitHub to delete branches.' : githubOAuthClientIdMissingMessage
    );
  }

  const branchName = name.trim();

  if (!branchName) {
    return branchMutationError('error', 'Branch name is required.');
  }

  try {
    const repoPath = repoApiPath(fullName);
    const repo = await requestGitHub<GitHubApiRepository>(`/repos/${repoPath}`, auth.token);

    if (repo.default_branch === branchName) {
      return branchMutationError('error', `Cannot delete default branch ${branchName}.`);
    }

    const encodedBranch = encodeURIComponent(branchName).replace(/%2F/g, '/');

    await requestGitHub<void>(`/repos/${repoPath}/git/refs/heads/${encodedBranch}`, auth.token, {
      method: 'DELETE'
    });

    return {
      message: `${branchName} deleted on GitHub.`,
      status: 'connected'
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';

    if (message.includes('Reference does not exist')) {
      return {
        message: `${branchName} was already deleted on GitHub.`,
        status: 'connected'
      };
    }

    return branchMutationError(
      'error',
      message || `Could not delete ${branchName}.`
    );
  }
}

export async function createGitHubIssue({
  body,
  fullName,
  labels,
  operationId,
  title
}: GitHubIssueCreateRequest): Promise<GitHubIssueCreationResult> {
  const auth = await resolveOAuthToken();

  if (!auth) {
    return {
      creationState: 'retryable',
      ...issueMutationError(
        getGitHubClientId() ? 'auth-required' : 'not-configured',
        getGitHubClientId()
          ? 'Connect GitHub to create issues.'
          : githubOAuthClientIdMissingMessage
      )
    };
  }

  const store = await getGitHubIssueCreationOperationStore().catch(() => null);
  if (!store) {
    return {
      creationState: 'uncertain',
      message: 'Project Space could not verify the saved creation attempt. Nothing new was sent to GitHub.',
      status: 'error'
    };
  }

  return createIdempotentGitHubIssue({
    remote: createLocalGitHubIssueCreationRemote(auth.token),
    request: { body, fullName, labels, operationId, title },
    store,
    userId: getCurrentAuthSession()?.userId ?? 'local-development-user'
  });
}

export async function createGitHubPullRequest({
  baseBranch,
  body,
  fullName,
  headBranch,
  issueNumber,
  title
}: GitHubPullRequestCreateRequest): Promise<GitHubPullRequestMutationResult> {
  const auth = await resolveOAuthToken();

  if (!auth) {
    return pullRequestMutationError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId()
        ? 'Connect GitHub to create pull requests.'
        : githubOAuthClientIdMissingMessage
    );
  }

  const trimmedTitle = title.trim();
  const trimmedHeadBranch = headBranch.trim();
  const trimmedBaseBranch = baseBranch.trim();

  if (!trimmedTitle || !trimmedHeadBranch || !trimmedBaseBranch) {
    return pullRequestMutationError('error', 'Title, head branch, and base branch are required.');
  }

  try {
    const linkedBody = [
      body?.trim(),
      issueNumber ? `Closes #${issueNumber}` : ''
    ].filter(Boolean).join('\n\n');
    const pullRequest = await requestGitHub<GitHubApiPullRequest>(
      `/repos/${repoApiPath(fullName)}/pulls`,
      auth.token,
      {
        body: JSON.stringify({
          base: trimmedBaseBranch,
          body: linkedBody || undefined,
          head: trimmedHeadBranch,
          title: trimmedTitle
        }),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST'
      }
    );

    return {
      pullRequest: mapGitHubPullRequest(pullRequest, issueNumber),
      status: 'connected'
    };
  } catch (error) {
    return pullRequestMutationError(
      'error',
      error instanceof Error ? error.message : 'Could not create GitHub pull request.'
    );
  }
}

interface UpdateGitHubIssueDependencies {
  requestGitHub: typeof requestGitHub;
  resolveOAuthToken: typeof resolveOAuthToken;
}

const updateGitHubIssueDependencies: UpdateGitHubIssueDependencies = {
  requestGitHub,
  resolveOAuthToken
};

export async function updateGitHubIssueWithDependencies({
  body,
  fullName,
  labels,
  number,
  state,
  title
}: GitHubIssueUpdateRequest,
  dependencies = updateGitHubIssueDependencies
): Promise<GitHubIssueMutationResult> {
  const auth = await dependencies.resolveOAuthToken();

  if (!auth) {
    return issueMutationError(
      getGitHubClientId() ? 'auth-required' : 'not-configured',
      getGitHubClientId() ? 'Connect GitHub to edit issues.' : githubOAuthClientIdMissingMessage
    );
  }

  try {
    const payload: Record<string, unknown> = {};

    if (title !== undefined) {
      payload.title = title.trim();
    }
    if (body !== undefined) {
      const currentIssue = await dependencies.requestGitHub<LocalGitHubApiIssue>(
        `/repos/${repoApiPath(fullName)}/issues/${number}`,
        auth.token
      );
      payload.body = preserveGitHubIssueCreationMarker(body, currentIssue.body ?? '');
    }
    if (labels !== undefined) {
      payload.labels = labels.filter(Boolean);
    }
    if (state !== undefined) {
      payload.state = state;
    }

    if (typeof payload.title === 'string' && !payload.title) {
      return issueMutationError('error', 'Issue title is required.');
    }

    const issue = await dependencies.requestGitHub<LocalGitHubApiIssue>(
      `/repos/${repoApiPath(fullName)}/issues/${number}`,
      auth.token,
      {
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'PATCH'
      }
    );

    return {
      issue: mapLocalGitHubIssue(issue),
      status: 'connected'
    };
  } catch (error) {
    return issueMutationError(
      'error',
      error instanceof Error ? error.message : 'Could not edit GitHub issue.'
    );
  }
}

export async function updateGitHubIssue(
  request: GitHubIssueUpdateRequest
): Promise<GitHubIssueMutationResult> {
  return updateGitHubIssueWithDependencies(request);
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
  const auth = await resolveOAuthToken();

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
