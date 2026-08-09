import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function toolResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
    structuredContent: { result: value } as Record<string, unknown>
  };
}

export function toolError(message: string, requestId?: string): CallToolResult {
  const suffix = requestId ? ` Request ID: ${requestId}` : '';
  return { content: [{ type: 'text', text: `${message}${suffix}` }], isError: true };
}

export function sanitizeRepository(repository: {
  defaultBranch?: string;
  fullName: string;
  id: number;
  isPrivate: boolean;
  projectConfig: unknown;
  url: string;
}) {
  return {
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    id: repository.id,
    isPrivate: repository.isPrivate,
    projectConfig: repository.projectConfig,
    url: repository.url
  };
}

export function sanitizeGitHubTask(
  task: {
    author?: string;
    body?: string;
    labels: string[];
    number: number;
    state: 'open' | 'closed';
    title: string;
    updatedAt?: string;
    url: string;
  },
  repository: { fullName: string }
) {
  return {
    author: task.author,
    body: task.body,
    id: `github:${repository.fullName}:${task.number}`,
    labels: task.labels,
    number: task.number,
    provider: 'github',
    repository: repository.fullName,
    state: task.state,
    title: task.title,
    updatedAt: task.updatedAt,
    url: task.url
  };
}

export function sanitizeGitHubIssueMutation(
  result: {
    creationState?: string;
    issue?: Parameters<typeof sanitizeGitHubTask>[0];
    message?: string;
    replayed?: boolean;
    status: string;
  },
  repository: { fullName: string }
) {
  return {
    creationState: result.creationState,
    message: result.message,
    replayed: result.replayed,
    repository: { fullName: repository.fullName },
    status: result.status,
    task: result.issue ? sanitizeGitHubTask(result.issue, repository) : undefined
  };
}

export function sanitizeGitHubComment(comment: {
  author?: string;
  body: string;
  createdAt?: string;
  id: number;
  updatedAt?: string;
  url: string;
}) {
  return {
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    updatedAt: comment.updatedAt,
    url: comment.url
  };
}

export function sanitizeGitHubBranch(branch: {
  commitSha?: string;
  isDefault: boolean;
  name: string;
  linkedIssueNumbers?: number[];
  url?: string;
}) {
  return {
    commitSha: branch.commitSha,
    isDefault: branch.isDefault,
    name: branch.name,
    url: branch.url
  };
}

export function sanitizeGitHubPullRequest(pullRequest: {
  author?: { avatarUrl?: string; login: string };
  baseBranch?: string;
  checksStatus?: string;
  headBranch?: string;
  headSha?: string;
  isDraft?: boolean;
  number: number;
  state: string;
  title: string;
  updatedAt?: string;
  url: string;
}) {
  return {
    author: pullRequest.author,
    baseBranch: pullRequest.baseBranch,
    checksStatus: pullRequest.checksStatus,
    headBranch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    isDraft: pullRequest.isDraft,
    number: pullRequest.number,
    state: pullRequest.state,
    title: pullRequest.title,
    updatedAt: pullRequest.updatedAt,
    url: pullRequest.url
  };
}

export function sanitizeGitHubWorkflowRun(run: {
  branch?: string;
  conclusion?: string;
  createdAt?: string;
  displayTitle?: string;
  event?: string;
  headSha?: string;
  id: number;
  kind: string;
  name?: string;
  runNumber?: number;
  runStartedAt?: string;
  status: string;
  updatedAt?: string;
  url?: string;
}) {
  return {
    branch: run.branch,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    displayTitle: run.displayTitle,
    event: run.event,
    headSha: run.headSha,
    id: run.id,
    kind: run.kind,
    name: run.name,
    runNumber: run.runNumber,
    runStartedAt: run.runStartedAt,
    status: run.status,
    updatedAt: run.updatedAt,
    url: run.url
  };
}

export function sanitizeCodexTaskStartResult(result: unknown) {
  if (!result || typeof result !== 'object' || !('state' in result) || result.state !== 'confirmed') {
    return result;
  }
  const confirmed = result as { task?: Record<string, unknown> };
  const sourceTask = confirmed.task?.issue;
  if (!sourceTask || typeof sourceTask !== 'object') return result;
  const { issue: _issue, ...task } = confirmed.task!;
  const source = sourceTask as { number?: unknown; url?: unknown };
  return {
    ...result,
    task: {
      ...task,
      source: { number: source.number, provider: 'github', url: source.url }
    }
  };
}

export function sanitizeSession(session: {
  attention?: string;
  archived: boolean;
  id: string;
  lastActivityAt: string;
  machineId: string;
  machineName: string;
  model?: string;
  project?: string;
  status: string;
  title: string;
}) {
  return {
    attention: session.attention,
    archived: session.archived,
    id: session.id,
    lastActivityAt: session.lastActivityAt,
    machineId: session.machineId,
    machineName: session.machineName,
    model: session.model,
    project: session.project,
    status: session.status,
    title: session.title
  };
}

export function sanitizeTaskRead<Result>(result: Result): Result {
  const copy = structuredClone(result) as Result & {
    result?: {
      session?: Parameters<typeof sanitizeSession>[0];
      turns?: Array<{ items: Array<{ images?: Array<{ id: string; mediaType: string }> }> }>;
    };
  };
  if (copy.result?.session) {
    copy.result.session = sanitizeSession(copy.result.session) as typeof copy.result.session;
  }
  for (const turn of copy.result?.turns ?? []) {
    for (const item of turn.items) {
      if (item.images) item.images = item.images.map(({ id, mediaType }) => ({ id, mediaType }));
    }
  }
  return copy;
}
