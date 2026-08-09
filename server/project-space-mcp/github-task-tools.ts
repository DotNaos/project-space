import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { currentRequestId, type ProjectSpaceLogger } from '../observability';
import { resolveGitHubRepository, resolveGitHubTask } from './github-resolver';
import {
  sanitizeGitHubBranch,
  sanitizeGitHubComment,
  sanitizeGitHubIssueMutation,
  sanitizeGitHubPullRequest,
  sanitizeGitHubTask,
  sanitizeGitHubWorkflowRun,
  sanitizeRepository,
  toolError,
  toolResult
} from './results';
import { toolSchemas } from './tool-catalog';

type GitHubTaskBackend = Pick<
  ProjectSpaceBackend,
  | 'createGitHubIssue'
  | 'createGitHubIssueComment'
  | 'getConnectorOverview'
  | 'getGitHubCatalog'
  | 'getGitHubIssueComments'
  | 'getGitHubPipelineStatus'
  | 'getGitHubRepositoryDetails'
  | 'loadProjectDiscovery'
  | 'updateGitHubIssue'
>;

export async function callGitHubTaskTool(input: {
  backend: GitHubTaskBackend;
  logger: ProjectSpaceLogger;
  name: string;
  rawArguments: Record<string, unknown>;
}): Promise<CallToolResult | undefined> {
  const { backend, logger, name, rawArguments } = input;
  switch (name) {
    case 'list_projects': {
      const parsed = toolSchemas.list_projects.parse(rawArguments);
      const [discovery, catalog] = await Promise.all([
        backend.loadProjectDiscovery(),
        backend.getGitHubCatalog().catch((error) => {
          logger.warn('mcp.github_catalog.unavailable', { tool: name }, error);
          return undefined;
        })
      ]);
      const search = parsed.search?.toLowerCase();
      const projects = discovery.projects
        .filter((project) => !search || [project.name, project.github?.fullName]
          .some((value) => value?.toLowerCase().includes(search)))
        .map((project) => ({
          branch: project.gitStatus?.branchName,
          changedFiles: project.gitStatus?.changed,
          github: project.github ? sanitizeRepository(project.github) : undefined,
          id: project.id,
          kind: project.kind,
          machineId: project.machineId,
          name: project.name
        }));
      const repositories = (catalog?.repositories ?? [])
        .filter((repository) => !search || repository.fullName.toLowerCase().includes(search))
        .map(sanitizeRepository);
      return toolResult({ catalogStatus: catalog?.status, projects, repositories });
    }
    case 'list_machines': {
      toolSchemas.list_machines.parse(rawArguments);
      const overview = await backend.getConnectorOverview();
      return toolResult({
        machines: overview.machines.map((machine) => ({
          capabilities: machine.connector.capabilities ?? [],
          environment: machine.environment,
          id: machine.id,
          kind: machine.kind,
          lastSeen: machine.connector.lastSeen,
          name: machine.name,
          roles: machine.roles,
          status: machine.connector.status
        })),
        physicalMachines: overview.physicalMachines ?? []
      });
    }
    case 'list_tasks': {
      const parsed = toolSchemas.list_tasks.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, parsed.repositoryId);
      if (!repository) {
        return toolResult({
          catalogStatus: catalog.status,
          message: catalog.message ?? 'The GitHub repository is not available.',
          repositoryId: parsed.repositoryId,
          tasks: undefined
        });
      }
      const details = await backend.getGitHubRepositoryDetails(repository.fullName);
      if (details.status !== 'connected') {
        return toolResult({
          checkedAt: details.checkedAt,
          message: details.message ?? 'GitHub task details are unavailable.',
          repository: sanitizeRepository(repository),
          status: details.status,
          tasks: undefined
        });
      }
      const state = parsed.state ?? 'open';
      const search = parsed.search?.toLowerCase();
      const matchingTasks = details.issues
        .filter((task) => state === 'all' || task.state === state)
        .filter((task) => !search || [task.title, task.body, ...task.labels]
          .some((value) => value?.toLowerCase().includes(search)))
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
      const limit = parsed.limit ?? 50;
      return toolResult({
        checkedAt: details.checkedAt,
        repository: sanitizeRepository(repository),
        status: details.status,
        tasks: matchingTasks.slice(0, limit).map((task) => sanitizeGitHubTask(task, repository)),
        truncated: matchingTasks.length > limit
      });
    }
    case 'get_task': {
      const parsed = toolSchemas.get_task.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, parsed.repositoryId);
      if (!repository) {
        return toolResult({
          catalogStatus: catalog.status,
          message: catalog.message ?? 'The GitHub repository is not available.',
          repositoryId: parsed.repositoryId,
          task: undefined
        });
      }
      const details = await backend.getGitHubRepositoryDetails(repository.fullName);
      if (details.status !== 'connected') {
        return toolResult({
          checkedAt: details.checkedAt,
          message: details.message ?? 'GitHub task details are unavailable.',
          repository: sanitizeRepository(repository),
          status: details.status,
          task: undefined
        });
      }
      const task = details.issues.find((candidate) => candidate.number === parsed.task);
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      return toolResult({
        checkedAt: details.checkedAt,
        repository: sanitizeRepository(repository),
        status: details.status,
        task: sanitizeGitHubTask(task, repository)
      });
    }
    case 'get_task_status': {
      const parsed = toolSchemas.get_task_status.parse(rawArguments);
      const { catalog, details, repository, task } = await resolveGitHubTask(
        backend,
        parsed.repositoryId,
        parsed.task
      );
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      const linkedBranches = details.branches
        .filter((branch) => branch.linkedIssueNumbers?.includes(parsed.task));
      const linkedPullRequests = details.pullRequests
        .filter((pullRequest) => pullRequest.linkedIssueNumbers?.includes(parsed.task));
      const branchNames = new Set(linkedBranches.map((branch) => branch.name));
      for (const pullRequest of linkedPullRequests) {
        if (pullRequest.headBranch) branchNames.add(pullRequest.headBranch);
      }
      const pipeline = await backend.getGitHubPipelineStatus(repository.fullName, { page: 1, perPage: 20 });
      return toolResult({
        branches: linkedBranches.map(sanitizeGitHubBranch),
        checkedAt: details.checkedAt,
        pipeline: {
          checkedAt: pipeline.checkedAt,
          pagination: pipeline.pagination,
          runs: pipeline.runs
            .filter((run) => (run.branch ? branchNames.has(run.branch) : false))
            .map(sanitizeGitHubWorkflowRun),
          status: pipeline.status
        },
        pullRequests: linkedPullRequests.map(sanitizeGitHubPullRequest),
        repository: sanitizeRepository(repository),
        status: details.status,
        task: sanitizeGitHubTask(task, repository)
      }, pipeline.status !== 'connected');
    }
    case 'create_task': {
      const parsed = toolSchemas.create_task.parse(rawArguments);
      const { catalog, repository } = await resolveGitHubRepository(backend, parsed.repositoryId);
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      const result = await backend.createGitHubIssue({
        body: parsed.body,
        fullName: repository.fullName,
        labels: parsed.labels,
        operationId: parsed.operationId,
        title: parsed.title
      });
      return toolResult(
        sanitizeGitHubIssueMutation(result, repository),
        result.status !== 'connected' || result.creationState === 'uncertain'
      );
    }
    case 'update_task': {
      const parsed = toolSchemas.update_task.parse(rawArguments);
      if (parsed.title === undefined && parsed.body === undefined
        && parsed.labels === undefined && parsed.state === undefined) {
        return toolError('At least one task field must be provided for an update.', currentRequestId());
      }
      const { catalog, details, repository, task } = await resolveGitHubTask(
        backend,
        parsed.repositoryId,
        parsed.task
      );
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.updateGitHubIssue({
        body: parsed.body,
        fullName: repository.fullName,
        labels: parsed.labels,
        number: parsed.task,
        state: parsed.state,
        title: parsed.title
      });
      return toolResult(sanitizeGitHubIssueMutation(result, repository), result.status !== 'connected');
    }
    case 'list_task_comments': {
      const parsed = toolSchemas.list_task_comments.parse(rawArguments);
      const { catalog, details, repository, task } = await resolveGitHubTask(
        backend,
        parsed.repositoryId,
        parsed.task
      );
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.getGitHubIssueComments(repository.fullName, parsed.task);
      return toolResult({
        comments: result.comments.map(sanitizeGitHubComment),
        message: result.message,
        repository: sanitizeRepository(repository),
        status: result.status,
        task: parsed.task
      }, result.status !== 'connected');
    }
    case 'add_task_comment': {
      const parsed = toolSchemas.add_task_comment.parse(rawArguments);
      const { catalog, details, repository, task } = await resolveGitHubTask(
        backend,
        parsed.repositoryId,
        parsed.task
      );
      if (!repository) {
        return toolError(catalog.message ?? 'The GitHub repository is not available.', currentRequestId());
      }
      if (details?.status !== 'connected') {
        return toolError(details?.message ?? 'GitHub task details are unavailable.', currentRequestId());
      }
      if (!task) return toolError('The GitHub task was not found.', currentRequestId());
      const result = await backend.createGitHubIssueComment({
        body: parsed.body,
        fullName: repository.fullName,
        number: parsed.task
      });
      return toolResult({
        comment: result.comment ? sanitizeGitHubComment(result.comment) : undefined,
        message: result.message,
        repository: sanitizeRepository(repository),
        status: result.status,
        task: parsed.task
      }, result.status !== 'connected');
    }
    default:
      return undefined;
  }
}
