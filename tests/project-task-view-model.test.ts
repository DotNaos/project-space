import { describe, expect, test } from 'bun:test';
import {
  createProjectTaskViewModels,
  projectTaskHealth,
  projectTaskState
} from '../src/features/project-tasks/task-view-model';
import type {
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary
} from '../src/shared/project-space-api';

const issue: GitHubIssueRecord = {
  labels: [],
  number: 437,
  state: 'open',
  title: 'Redesign the Project Space frontend',
  url: 'https://github.com/DotNaos/project-space/issues/437'
};

function pullRequest(overrides: Partial<GitHubPullRequestRecord>): GitHubPullRequestRecord {
  return {
    number: 438,
    state: 'open',
    title: 'Redesign the Project Space frontend',
    url: 'https://github.com/DotNaos/project-space/pull/438',
    ...overrides
  };
}

describe('project task view model', () => {
  test('derives backlog, started, in progress, and done from GitHub truth', () => {
    expect(projectTaskState(issue)).toBe('backlog');
    expect(projectTaskState(issue, pullRequest({ isDraft: true }))).toBe('started');
    expect(projectTaskState(issue, pullRequest({ isDraft: false }))).toBe('in-progress');
    expect(projectTaskState(issue, pullRequest({ state: 'merged' }))).toBe('done');
  });

  test('treats an exact-head failed run as attention', () => {
    const run: GitHubWorkflowRunSummary = {
      conclusion: 'failure',
      headSha: 'abc123',
      id: 1,
      kind: 'ci',
      status: 'completed'
    };
    expect(projectTaskHealth(run)).toBe('attention');
    const [task] = createProjectTaskViewModels({
      branches: [],
      issues: [issue],
      pullRequests: [pullRequest({ headSha: 'abc123', linkedIssueNumbers: [437] })],
      runs: [run]
    });
    expect(task.pipeline?.id).toBe(1);
    expect(task.health).toBe('attention');
    expect(task.state).toBe('in-progress');
  });

  test('does not reuse a successful run from an older revision of the same branch', () => {
    const tasks = createProjectTaskViewModels({
      branches: [],
      issues: [issue],
      pullRequests: [pullRequest({
        headBranch: 'issue-437-redesign',
        headSha: 'current-head',
        isDraft: true,
        linkedIssueNumbers: [437]
      })],
      runs: [{
        branch: 'issue-437-redesign',
        conclusion: 'success',
        headSha: 'previous-head',
        id: 2,
        kind: 'ci',
        status: 'completed'
      }]
    });

    expect(tasks[0]?.pipeline).toBeUndefined();
    expect(tasks[0]?.health).toBe('unknown');
  });

  test('prefers the open linked pull request when history contains merged work', () => {
    const [task] = createProjectTaskViewModels({
      branches: [],
      issues: [issue],
      pullRequests: [
        pullRequest({ number: 435, state: 'merged', linkedIssueNumbers: [437] }),
        pullRequest({ isDraft: true, number: 438, linkedIssueNumbers: [437] })
      ]
    });
    expect(task.pullRequest?.number).toBe(438);
    expect(task.state).toBe('started');
  });
});
