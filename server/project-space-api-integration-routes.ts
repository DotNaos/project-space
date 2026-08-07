import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  projectSpaceCorsHeaders,
  readJson,
  writeJson
} from './project-space-http-response';
import type {
  CodexChatRequest,
  CodexModelCatalogueRequest,
  CodexOpenRequest,
  GitCommitRequest,
  GitDiffRequest,
  GitHistoryRequest,
  GitHubBranchCreateRequest,
  GitHubBranchDeleteRequest,
  GitHubHistoryRequest,
  GitHubIssueCommentCreateRequest,
  GitHubIssueCreateRequest,
  GitHubIssueDevelopmentStartRequest,
  GitHubIssueUpdateRequest,
  GitHubOAuthDevicePollRequest,
  GitHubPullRequestCreateRequest,
  GitStageRequest,
  MachineTerminalCommandRequest,
  ProjectBackupRequest,
  ProjectDeployRequest,
  RoadmapDependencyMutationRequest,
  RoadmapPlanUpdateRequest,
  ProjectSpaceBackend,
  ScopeDevboxStartRequest,
  TemplateAdherenceRequest,
  TerminalCommandRequest,
  ToolLaunchRequest
} from '../src/shared/project-space-api';
import { createGitHubRepositorySummaryRoute } from './github-repository-summary-route';
import { isGitHubBranchComparisonRequest } from './github-branch-comparison';
import { isGitHubIssueDevelopmentStartRequest } from './local-github-issue-development';
import type { GitHubRepositorySummaryResult } from '../src/shared/github-repository-summary';

interface ProjectSpaceIntegrationApiRouteOptions {
  loadGitHubRepositorySummary?(fullName: string): Promise<GitHubRepositorySummaryResult>;
}

export function createProjectSpaceIntegrationApiRoutes(
  backend: ProjectSpaceBackend,
  options: ProjectSpaceIntegrationApiRouteOptions = {}
) {
  const handleRepositorySummary = createGitHubRepositorySummaryRoute({
    loadSummary: options.loadGitHubRepositorySummary
  });

  return async function handleProjectSpaceIntegrationApiRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (await handleRepositorySummary(request, response, url)) return true;

    if (request.method === 'POST' && url.pathname === '/api/template/adherence') {
      const payload = await readJson<TemplateAdherenceRequest>(request);
      if (!payload?.cwd) {
        writeJson(response, 400, { error: 'Missing cwd.' });
        return true;
      }

      writeJson(response, 200, await backend.getTemplateAdherence(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/github/catalog') {
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.getGitHubCatalog({
        forceRefresh: url.searchParams.get('refresh') === '1'
      }));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/github/repository-details') {
      const fullName = url.searchParams.get('fullName');
      if (!fullName) {
        writeJson(response, 400, { error: 'Missing fullName.' });
        return true;
      }

      writeJson(response, 200, await backend.getGitHubRepositoryDetails(fullName));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/github/roadmap') {
      const fullName = url.searchParams.get('fullName');
      if (!fullName) {
        writeJson(response, 400, { error: 'Missing fullName.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.getRoadmap(fullName));
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/api/github/roadmap/plan') {
      const payload = await readJson<RoadmapPlanUpdateRequest>(request);
      if (
        !payload?.fullName
        || !Array.isArray(payload.goals)
        || !Array.isArray(payload.items)
        || typeof payload.expectedGraphRevision !== 'string'
        || !Number.isSafeInteger(payload.expectedRevision)
        || payload.expectedRevision < 0
      ) {
        writeJson(response, 400, { error: 'Missing or invalid roadmap plan.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.updateRoadmapPlan(payload));
      return true;
    }

    if (
      ['POST', 'DELETE'].includes(request.method ?? '')
      && url.pathname === '/api/github/roadmap/dependencies'
    ) {
      const payload = await readJson<RoadmapDependencyMutationRequest>(request);
      if (
        !payload?.fullName
        || !payload.blocker?.fullName
        || !Number.isSafeInteger(payload.blockedIssueNumber)
        || payload.blockedIssueNumber <= 0
        || !Number.isSafeInteger(payload.blocker.issueNumber)
        || payload.blocker.issueNumber <= 0
        || typeof payload.expectedGraphRevision !== 'string'
      ) {
        writeJson(response, 400, { error: 'Missing or invalid roadmap dependency.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(
        response,
        200,
        request.method === 'POST'
          ? await backend.addRoadmapDependency(payload)
          : await backend.removeRoadmapDependency(payload)
      );
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/github/pipeline') {
      const fullName = url.searchParams.get('fullName');
      if (!fullName) {
        writeJson(response, 400, { error: 'Missing fullName.' });
        return true;
      }

      response.setHeader('Cache-Control', 'private, no-store');
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('perPage') ?? '20');
      if (!Number.isSafeInteger(page) || page <= 0 || !Number.isSafeInteger(perPage) || perPage <= 0 || perPage > 50) {
        writeJson(response, 400, { error: 'Invalid workflow pagination.' });
        return true;
      }
      writeJson(response, 200, await backend.getGitHubPipelineStatus(fullName, { page, perPage }));
      return true;
    }

    const workflowRunMatch = url.pathname.match(/^\/api\/github\/workflow-runs\/(\d+)$/);
    if (request.method === 'GET' && workflowRunMatch?.[1]) {
      const fullName = url.searchParams.get('fullName');
      const runId = Number(workflowRunMatch[1]);
      if (!fullName || !Number.isSafeInteger(runId) || runId <= 0) {
        writeJson(response, 400, { error: 'Missing or invalid fullName or run ID.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.getGitHubWorkflowRunDetail(fullName, runId));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/issues') {
      const payload = await readJson<GitHubIssueCreateRequest>(request);
      writeJson(response, 200, await backend.createGitHubIssue(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/branches') {
      const payload = await readJson<GitHubBranchCreateRequest>(request);
      writeJson(response, 200, await backend.createGitHubBranch(payload));
      return true;
    }

    if (request.method === 'DELETE' && url.pathname === '/api/github/branches') {
      const payload = await readJson<GitHubBranchDeleteRequest>(request);
      writeJson(response, 200, await backend.deleteGitHubBranch(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/pull-requests') {
      const payload = await readJson<GitHubPullRequestCreateRequest>(request);
      writeJson(response, 200, await backend.createGitHubPullRequest(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/issue-development') {
      const payload = await readJson<GitHubIssueDevelopmentStartRequest>(request);
      if (!isGitHubIssueDevelopmentStartRequest(payload)) {
        writeJson(response, 400, { error: 'Invalid issue development request.' });
        return true;
      }
      writeJson(response, 200, await backend.startGitHubIssueDevelopment(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/github/issue-comments') {
      const fullName = url.searchParams.get('fullName');
      const number = Number(url.searchParams.get('number') ?? '');
      if (!fullName || !Number.isFinite(number)) {
        writeJson(response, 400, { error: 'Missing fullName or number.' });
        return true;
      }

      writeJson(response, 200, await backend.getGitHubIssueComments(fullName, number));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/issue-comments') {
      const payload = await readJson<GitHubIssueCommentCreateRequest>(request);
      writeJson(response, 200, await backend.createGitHubIssueComment(payload));
      return true;
    }

    if (request.method === 'PATCH' && url.pathname === '/api/github/issues') {
      const payload = await readJson<GitHubIssueUpdateRequest>(request);
      writeJson(response, 200, await backend.updateGitHubIssue(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/oauth/device/start') {
      writeJson(response, 200, await backend.startGitHubOAuthDeviceFlow());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/oauth/device/poll') {
      const payload = await readJson<GitHubOAuthDevicePollRequest>(request);
      writeJson(response, 200, await backend.pollGitHubOAuthDeviceFlow(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/platform/overview') {
      writeJson(response, 200, await backend.getPlatformOverview());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/deploy-project') {
      const payload = await readJson<ProjectDeployRequest>(request);
      writeJson(response, 200, await backend.deployProject(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/backup-project') {
      const payload = await readJson<ProjectBackupRequest>(request);
      writeJson(response, 200, await backend.backupProject(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/open-target') {
      const payload = await readJson<CodexOpenRequest>(request);
      writeJson(response, 200, await backend.openCodexTarget(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/models') {
      const payload = await readJson<CodexModelCatalogueRequest>(request);
      writeJson(response, 200, await backend.getCodexModels(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/chat') {
      const payload = await readJson<CodexChatRequest>(request);
      writeJson(response, 200, await backend.runCodexChat(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/chat/stream') {
      const payload = await readJson<CodexChatRequest>(request);
      response.writeHead(200, {
        ...projectSpaceCorsHeaders(),
        'Cache-Control': 'no-store',
        'Content-Type': 'application/x-ndjson; charset=utf-8'
      });
      await backend.streamCodexChat(payload, (event) => {
        response.write(`${JSON.stringify(event)}\n`);
      });
      response.end();
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/terminal/run') {
      const payload = await readJson<TerminalCommandRequest>(request);
      writeJson(response, 200, await backend.runTerminalCommand(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/terminal/run') {
      const payload = await readJson<MachineTerminalCommandRequest>(request);
      writeJson(response, 200, await backend.runMachineTerminalCommand(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/scope-devbox/overview') {
      writeJson(response, 200, await backend.getScopeDevboxOverview());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/scope-devbox/jobs') {
      const payload = await readJson<ScopeDevboxStartRequest>(request);
      writeJson(response, 200, await backend.startScopeDevboxJob(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/git/status') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) {
        writeJson(response, 400, { error: 'Missing cwd.' });
        return true;
      }

      writeJson(response, 200, await backend.getGitStatus(cwd));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/history') {
      const payload = await readJson<GitHistoryRequest>(request);
      writeJson(response, 200, await backend.getGitHistory(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/history') {
      const payload = await readJson<GitHubHistoryRequest>(request);
      writeJson(response, 200, await backend.getGitHubHistory(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/github/branch-comparison') {
      const payload = await readJson<unknown>(request);
      if (!isGitHubBranchComparisonRequest(payload)) {
        writeJson(response, 400, { error: 'Invalid GitHub branch comparison request.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.getGitHubBranchComparison(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/diff') {
      const payload = await readJson<GitDiffRequest>(request);
      writeJson(response, 200, await backend.getGitDiff(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/stage') {
      const payload = await readJson<GitStageRequest>(request);
      writeJson(response, 200, await backend.stageGitPaths(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/unstage') {
      const payload = await readJson<GitStageRequest>(request);
      writeJson(response, 200, await backend.unstageGitPaths(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/git/commit') {
      const payload = await readJson<GitCommitRequest>(request);
      writeJson(response, 200, await backend.commitGitChanges(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace-tool/open') {
      const payload = await readJson<ToolLaunchRequest>(request);
      writeJson(response, 200, await backend.openWorkspaceTool(payload));
      return true;
    }

    return false;
  };
}
