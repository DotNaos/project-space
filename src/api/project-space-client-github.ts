import type {
  GitHubRepositoryFileResult,
  GitHubRepositoryTreeResult
} from '@/shared/github-repository-tree';
import type {
  GitHubBranchCreateRequest,
  GitHubBranchComparisonRequest,
  GitHubBranchComparisonResult,
  GitHubBranchDeleteRequest,
  GitHubBranchMutationResult,
  GitHubCatalogResult,
  GitHubHistoryRequest,
  GitHubIssueCommentCreateRequest,
  GitHubIssueCommentMutationResult,
  GitHubIssueCommentsResult,
  GitHubIssueCreateRequest,
  GitHubIssueCreationResult,
  GitHubIssueDevelopmentStartRequest,
  GitHubIssueDevelopmentStartResult,
  GitHubIssueMutationResult,
  GitHubIssueUpdateRequest,
  GitHubOAuthDevicePollRequest,
  GitHubOAuthDevicePollResult,
  GitHubOAuthDeviceStartResult,
  GitHubPipelineStatusResult,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestMutationResult,
  GitHubRepositoryDetailsResult,
  GitHistoryResult,
  RoadmapDependencyMutationRequest,
  RoadmapPlanUpdateRequest,
  RoadmapResult
} from '@/shared/project-space-api';
import { ProjectSpaceHttpClient } from './project-space-client-http';

const githubRepositoryDetailsRequests = new Map<string, Promise<GitHubRepositoryDetailsResult>>();

export class GitHubProjectSpaceClient extends ProjectSpaceHttpClient {
  getGitHubCatalog(options: { forceRefresh?: boolean } = {}): Promise<GitHubCatalogResult> {
    return this.request(`/api/github/catalog${options.forceRefresh ? '?refresh=1' : ''}`);
  }

  createGitHubIssue(request: GitHubIssueCreateRequest): Promise<GitHubIssueCreationResult> {
    return this.request('/api/github/issues', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  createGitHubBranch(request: GitHubBranchCreateRequest): Promise<GitHubBranchMutationResult> {
    return this.request('/api/github/branches', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  deleteGitHubBranch(request: GitHubBranchDeleteRequest): Promise<GitHubBranchMutationResult> {
    return this.request('/api/github/branches', {
      body: JSON.stringify(request),
      method: 'DELETE'
    });
  }

  createGitHubPullRequest(
    request: GitHubPullRequestCreateRequest
  ): Promise<GitHubPullRequestMutationResult> {
    return this.request('/api/github/pull-requests', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  startGitHubIssueDevelopment(
    request: GitHubIssueDevelopmentStartRequest
  ): Promise<GitHubIssueDevelopmentStartResult> {
    return this.request('/api/github/issue-development', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  createGitHubIssueComment(
    request: GitHubIssueCommentCreateRequest
  ): Promise<GitHubIssueCommentMutationResult> {
    return this.request('/api/github/issue-comments', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubIssueComments(fullName: string, number: number): Promise<GitHubIssueCommentsResult> {
    const query = new URLSearchParams({ fullName, number: String(number) });
    return this.request(`/api/github/issue-comments?${query.toString()}`);
  }

  getGitHubPipelineStatus(
    fullName: string,
    options: { page?: number; perPage?: number } = {}
  ): Promise<GitHubPipelineStatusResult> {
    const query = new URLSearchParams({ fullName });
    if (options.page) query.set('page', String(options.page));
    if (options.perPage) query.set('perPage', String(options.perPage));
    return this.request(`/api/github/pipeline?${query.toString()}`);
  }

  getGitHubWorkflowRunDetail(
    fullName: string,
    runId: number
  ): Promise<import('@/shared/project-space-api').GitHubWorkflowRunDetailResult> {
    const query = new URLSearchParams({ fullName });
    return this.request(`/api/github/workflow-runs/${runId}?${query.toString()}`);
  }

  getGitHubRepositoryDetails(fullName: string): Promise<GitHubRepositoryDetailsResult> {
    const query = new URLSearchParams({ fullName });
    const cacheKey = query.toString();
    const activeRequest = githubRepositoryDetailsRequests.get(cacheKey);

    if (activeRequest) {
      return activeRequest;
    }

    const request = this.request<GitHubRepositoryDetailsResult>(
      `/api/github/repository-details?${cacheKey}`
    ).finally(() => {
      githubRepositoryDetailsRequests.delete(cacheKey);
    });

    githubRepositoryDetailsRequests.set(cacheKey, request);
    return request;
  }

  getGitHubRepositoryTree(
    fullName: string,
    ref: string
  ): Promise<GitHubRepositoryTreeResult> {
    const query = new URLSearchParams({ fullName, ref });
    return this.request(`/api/github/repository-tree?${query.toString()}`);
  }

  getGitHubRepositoryFile(
    fullName: string,
    ref: string,
    path: string
  ): Promise<GitHubRepositoryFileResult> {
    const query = new URLSearchParams({ fullName, path, ref });
    return this.request(`/api/github/repository-file?${query.toString()}`);
  }

  getRoadmap(fullName: string): Promise<RoadmapResult> {
    const query = new URLSearchParams({ fullName });
    return this.request(`/api/github/roadmap?${query.toString()}`);
  }

  updateRoadmapPlan(request: RoadmapPlanUpdateRequest): Promise<RoadmapResult> {
    return this.request('/api/github/roadmap/plan', {
      body: JSON.stringify(request),
      method: 'PUT'
    });
  }

  addRoadmapDependency(request: RoadmapDependencyMutationRequest): Promise<RoadmapResult> {
    return this.request('/api/github/roadmap/dependencies', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  removeRoadmapDependency(request: RoadmapDependencyMutationRequest): Promise<RoadmapResult> {
    return this.request('/api/github/roadmap/dependencies', {
      body: JSON.stringify(request),
      method: 'DELETE'
    });
  }

  updateGitHubIssue(request: GitHubIssueUpdateRequest): Promise<GitHubIssueMutationResult> {
    return this.request('/api/github/issues', {
      body: JSON.stringify(request),
      method: 'PATCH'
    });
  }

  getGitHubHistory(request: GitHubHistoryRequest): Promise<GitHistoryResult> {
    return this.request('/api/github/history', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  getGitHubBranchComparison(
    request: GitHubBranchComparisonRequest
  ): Promise<GitHubBranchComparisonResult> {
    return this.request('/api/github/branch-comparison', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }

  startGitHubOAuthDeviceFlow(): Promise<GitHubOAuthDeviceStartResult> {
    return this.request('/api/github/oauth/device/start', {
      method: 'POST'
    });
  }

  pollGitHubOAuthDeviceFlow(
    request: GitHubOAuthDevicePollRequest
  ): Promise<GitHubOAuthDevicePollResult> {
    return this.request('/api/github/oauth/device/poll', {
      body: JSON.stringify(request),
      method: 'POST'
    });
  }
}
