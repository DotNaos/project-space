import { describe, expect, test } from 'bun:test';
import {
  createProjectTaskViewModels,
  projectTaskHealth,
  projectTaskState,
  projectTaskWorkflowMessage
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
const defaultBranch = { commitSha: 'f'.repeat(40), isDefault: true, name: 'main' };

function pullRequest(overrides: Partial<GitHubPullRequestRecord>): GitHubPullRequestRecord {
  return {
    baseBranch: 'main',
    headBranch: 'issue-437-redesign',
    headRefPresent: true,
    headRepositoryFullName: 'DotNaos/project-space',
    headSha: 'a'.repeat(40),
    isCrossRepository: false,
    number: 438,
    state: 'open',
    title: 'Redesign the Project Space frontend',
    url: 'https://github.com/DotNaos/project-space/pull/438',
    ...overrides
  };
}

describe('project task view model', () => {
  test('derives backlog, active, review, and completed from GitHub truth', () => {
    expect(projectTaskState(issue)).toBe('backlog');
    expect(projectTaskState(issue, undefined, {
      commitSha: 'b'.repeat(40),
      isDefault: false,
      linkedIssueNumbers: [437],
      name: 'issue-437-redesign'
    })).toBe('active');
    expect(projectTaskState(issue, pullRequest({ isDraft: true }))).toBe('active');
    expect(projectTaskState(issue, pullRequest({ isDraft: false }))).toBe('review');
    expect(projectTaskState(issue, pullRequest({ state: 'merged' }))).toBe('review');
    expect(projectTaskState(
      { ...issue, state: 'closed' },
      pullRequest({ state: 'merged' })
    )).toBe('completed');
  });

  test('keeps contradictory and partial GitHub states recoverable', () => {
    const branch = {
      commitSha: 'b'.repeat(40),
      isDefault: false,
      linkedIssueNumbers: [437],
      name: 'issue-437-redesign'
    };
    expect(projectTaskWorkflowMessage(issue, branch)).toBeUndefined();
    expect(projectTaskWorkflowMessage(issue, undefined, pullRequest({ state: 'merged' })))
      .toContain('still open');
    expect(projectTaskWorkflowMessage(
      { ...issue, state: 'closed' },
      undefined,
      pullRequest({ state: 'closed' })
    )).toContain('without a verified merged');
    expect(projectTaskWorkflowMessage(issue, undefined, pullRequest({ isDraft: undefined })))
      .toContain('could not be verified');
  });

  test('places one verified linked branch without a pull request in Active', () => {
    const [task] = createProjectTaskViewModels({
      branches: [defaultBranch, {
        commitSha: 'b'.repeat(40),
        isDefault: false,
        linkedIssueNumbers: [437],
        name: 'issue-437-redesign'
      }],
      issues: [issue],
      pullRequests: [],
      repositoryFullName: 'DotNaos/project-space'
    });

    expect(task.state).toBe('active');
    expect(task.workflowMessage).toBeUndefined();
  });

  test('treats an exact-head failed run as attention', () => {
    const run: GitHubWorkflowRunSummary = {
      conclusion: 'failure',
      headSha: 'a'.repeat(40),
      id: 1,
      kind: 'ci',
      status: 'completed'
    };
    expect(projectTaskHealth(run)).toBe('attention');
    const [task] = createProjectTaskViewModels({
      branches: [defaultBranch],
      issues: [issue],
      pullRequests: [pullRequest({ isDraft: false, linkedIssueNumbers: [437] })],
      repositoryFullName: 'DotNaos/project-space',
      runs: [run]
    });
    expect(task.pipeline?.id).toBe(1);
    expect(task.health).toBe('attention');
    expect(task.state).toBe('review');
  });

  test('does not reuse a successful run from an older revision of the same branch', () => {
    const tasks = createProjectTaskViewModels({
      branches: [defaultBranch],
      issues: [issue],
      pullRequests: [pullRequest({
        headBranch: 'issue-437-redesign',
        headSha: 'current-head',
        isDraft: true,
        linkedIssueNumbers: [437]
      })],
      repositoryFullName: 'DotNaos/project-space',
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
      branches: [defaultBranch],
      issues: [issue],
      pullRequests: [
        pullRequest({ number: 435, state: 'merged', linkedIssueNumbers: [437] }),
        pullRequest({ isDraft: true, number: 438, linkedIssueNumbers: [437] })
      ],
      repositoryFullName: 'DotNaos/project-space'
    });
    expect(task.pullRequest?.number).toBe(438);
    expect(task.state).toBe('active');
  });

  test('shows a same-head draft pull request before issue-link metadata catches up', () => {
    const [task] = createProjectTaskViewModels({
      branches: [defaultBranch, {
        commitSha: 'a'.repeat(40),
        isDefault: false,
        linkedIssueNumbers: [437],
        name: 'issue-437-redesign'
      }],
      issues: [issue],
      pullRequests: [pullRequest({ isDraft: true, linkedIssueNumbers: [] })],
      repositoryFullName: 'DotNaos/project-space'
    });

    expect(task.pullRequest?.number).toBe(438);
    expect(task.state).toBe('active');
  });

  test('does not present an unverified open pull request as active work', () => {
    const [task] = createProjectTaskViewModels({
      branches: [defaultBranch],
      issues: [issue],
      pullRequests: [pullRequest({
        headRepositoryFullName: 'someone/project-space',
        isCrossRepository: true,
        isDraft: true,
        linkedIssueNumbers: [437]
      })],
      repositoryFullName: 'DotNaos/project-space'
    });

    expect(task.state).toBe('backlog');
    expect(task.workflowMessage).toContain('fork');
  });

  test('keeps a merged pull request in review until the issue closes', () => {
    const [task] = createProjectTaskViewModels({
      branches: [defaultBranch],
      issues: [issue],
      pullRequests: [pullRequest({ linkedIssueNumbers: [437], state: 'merged' })],
      repositoryFullName: 'DotNaos/project-space'
    });

    expect(task.state).toBe('review');
    expect(task.workflowMessage).toContain('still open');
    expect(task.pullRequest?.state).toBe('merged');
  });
});
