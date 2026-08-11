import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  GitHubBranchCreateRequest,
  GitHubBranchDeleteRequest,
  GitHubIssueCreateRequest,
  GitHubIssueDevelopmentStartRequest,
  GitHubIssueUpdateRequest,
  GitHubPullRequestCreateRequest
} from '../../src/shared/project-space-api';
import { readJson, writeJson } from '../project-space-http-response';
import type { LocalSimulationStore } from './store';
import type { LocalSimulationState } from './state';

function simulatedSha(value: string) {
  return createHash('sha1').update(`project-space-local-simulation\0${value}`).digest('hex');
}

function createBranch(
  state: LocalSimulationState,
  request: GitHubBranchCreateRequest
) {
  const name = request.name.trim();
  let branch = state.github.branches.find((candidate) => candidate.name === name);
  if (!branch) {
    branch = {
      commitSha: simulatedSha(name),
      isDefault: false,
      ...(request.issueNumber ? { linkedIssueNumbers: [request.issueNumber] } : {}),
      name,
      url: ''
    };
    state.github.branches.push(branch);
  }
  return branch;
}

function createPullRequest(
  state: LocalSimulationState,
  request: GitHubPullRequestCreateRequest
) {
  let pullRequest = state.github.pullRequests.find(
    (candidate) => candidate.state === 'open' && candidate.headBranch === request.headBranch
  );
  if (!pullRequest) {
    const branch = state.github.branches.find((candidate) => candidate.name === request.headBranch);
    pullRequest = {
      author: { login: 'Local developer' },
      baseBranch: request.baseBranch,
      checksStatus: 'pending',
      headBranch: request.headBranch,
      headRefPresent: true,
      headRepositoryFullName: state.github.repository.fullName,
      headSha: branch?.commitSha ?? simulatedSha(request.headBranch),
      isCrossRepository: false,
      isDraft: request.draft ?? true,
      ...(request.issueNumber ? { linkedIssueNumbers: [request.issueNumber] } : {}),
      number: Math.max(0, ...state.github.pullRequests.map((candidate) => candidate.number)) + 1,
      state: 'open',
      title: request.title.trim(),
      updatedAt: new Date().toISOString(),
      url: ''
    };
    state.github.pullRequests.push(pullRequest);
  }
  return pullRequest;
}

export async function handleLocalSimulationGitHubMutation(options: {
  method: string;
  request: IncomingMessage;
  response: ServerResponse;
  state: LocalSimulationState;
  store: LocalSimulationStore;
  url: URL;
}) {
  const { method, request, response, state, store, url } = options;

  if (method === 'POST' && url.pathname === '/api/github/issues') {
    const payload = await readJson<GitHubIssueCreateRequest>(request);
    const created = await store.update((current) => {
      const existingNumber = current.issueCreationOperations?.[payload.operationId];
      const existing = current.github.issues.find((issue) => issue.number === existingNumber);
      if (existing) return { issue: existing, replayed: true };
      const next = {
        author: 'Local developer', body: payload.body ?? '', id: current.revision + 1_000,
        labels: payload.labels ?? [],
        number: Math.max(0, ...current.github.issues.map((candidate) => candidate.number)) + 1,
        state: 'open' as const, title: payload.title.trim(), updatedAt: new Date().toISOString(), url: ''
      };
      current.github.issues.push(next);
      (current.issueCreationOperations ??= {})[payload.operationId] = next.number;
      current.github.comments[String(next.number)] = [];
      return { issue: next, replayed: false };
    });
    writeJson(response, 200, { creationState: 'complete', ...created, status: 'connected' });
    return true;
  }

  if (method === 'PATCH' && url.pathname === '/api/github/issues') {
    const payload = await readJson<GitHubIssueUpdateRequest>(request);
    const issue = await store.update((current) => {
      const target = current.github.issues.find((candidate) => candidate.number === payload.number);
      if (!target) return undefined;
      if (payload.body !== undefined) target.body = payload.body;
      if (payload.labels !== undefined) target.labels = payload.labels;
      if (payload.state !== undefined) target.state = payload.state;
      if (payload.title !== undefined) target.title = payload.title.trim();
      target.updatedAt = new Date().toISOString();
      return target;
    });
    writeJson(response, 200, issue ? { issue, status: 'connected' } : { message: 'Issue not found.', status: 'error' });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/github/branches') {
    const payload = await readJson<GitHubBranchCreateRequest>(request);
    const branch = await store.update((current) => createBranch(current, payload));
    writeJson(response, 200, { branch, status: 'connected' });
    return true;
  }

  if (method === 'DELETE' && url.pathname === '/api/github/branches') {
    const payload = await readJson<GitHubBranchDeleteRequest>(request);
    await store.update((current) => {
      current.github.branches = current.github.branches.filter(
        (branch) => branch.isDefault || branch.name !== payload.name
      );
    });
    writeJson(response, 200, { status: 'connected' });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/github/pull-requests') {
    const payload = await readJson<GitHubPullRequestCreateRequest>(request);
    const pullRequest = await store.update((current) => createPullRequest(current, payload));
    writeJson(response, 200, { pullRequest, status: 'connected' });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/github/issue-development') {
    const payload = await readJson<GitHubIssueDevelopmentStartRequest>(request);
    const result = await store.update((current) => {
      const reusedBranch = current.github.branches.some((branch) => branch.name === payload.branchName);
      const branch = createBranch(current, {
        fullName: payload.fullName,
        issueNumber: payload.issueNumber,
        name: payload.branchName
      });
      const reusedPullRequest = current.github.pullRequests.some(
        (candidate) => candidate.state === 'open' && candidate.headBranch === payload.branchName
      );
      const issue = current.github.issues.find((candidate) => candidate.number === payload.issueNumber);
      const pullRequest = createPullRequest(current, {
        baseBranch: current.github.repository.defaultBranch,
        draft: true,
        fullName: payload.fullName,
        headBranch: payload.branchName,
        issueNumber: payload.issueNumber,
        title: issue?.title ?? `Develop issue #${payload.issueNumber}`
      });
      return { branch, pullRequest, reusedBranch, reusedPullRequest };
    });
    writeJson(response, 200, {
      branch: result.branch,
      branchDisposition: result.reusedBranch ? 'reused' : 'created',
      pullRequest: result.pullRequest,
      pullRequestDisposition: result.reusedPullRequest ? 'reused' : 'created',
      state: 'ready',
      status: 'connected'
    });
    return true;
  }

  return false;
}
