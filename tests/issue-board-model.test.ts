import { describe, expect, test } from 'bun:test';
import type {
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import {
  filterIssues,
  groupIssuesByColumn,
  normalizeIssueColumnOrder,
  resolveIssueColumn,
  topIssueLabels
} from '../src/features/project-desktop/components/issue-board-model';

function issue(
  number: number,
  title: string,
  labels: string[] = [],
  state: GitHubIssueRecord['state'] = 'open'
): GitHubIssueRecord {
  return { labels, number, state, title, url: `https://github.test/issues/${number}` };
}

function pullRequest(
  number: number,
  linkedIssueNumbers: number[],
  state: GitHubPullRequestRecord['state'] = 'open'
): GitHubPullRequestRecord {
  return {
    linkedIssueNumbers,
    number,
    state,
    title: `Pull request ${number}`,
    url: `https://github.test/pull/${number}`
  };
}

describe('issue board model', () => {
  test('derives columns from GitHub issue state and linked pull requests', () => {
    const backlog = issue(1, 'Unstarted work');
    const inProgress = issue(2, 'Active work');
    const closedWithPullRequest = issue(3, 'Done', [], 'closed');
    const pullRequests = [
      pullRequest(20, [2]),
      pullRequest(21, [3], 'merged')
    ];

    expect(resolveIssueColumn(backlog, pullRequests)).toBe('backlog');
    expect(resolveIssueColumn(inProgress, pullRequests)).toBe('in-progress');
    expect(resolveIssueColumn(closedWithPullRequest, pullRequests)).toBe('closed');
    expect(groupIssuesByColumn(
      [backlog, inProgress, closedWithPullRequest],
      pullRequests
    )).toEqual({
      backlog: [backlog],
      closed: [closedWithPullRequest],
      'in-progress': [inProgress]
    });
  });

  test('treats every linked pull request state as active until the issue closes', () => {
    const openIssue = issue(8, 'Follow-up remains open');

    expect(resolveIssueColumn(openIssue, [pullRequest(80, [8], 'open')])).toBe('in-progress');
    expect(resolveIssueColumn(openIssue, [pullRequest(81, [8], 'closed')])).toBe('in-progress');
    expect(resolveIssueColumn(openIssue, [pullRequest(82, [8], 'merged')])).toBe('in-progress');
  });

  test('normalizes board order without losing or duplicating columns', () => {
    expect(normalizeIssueColumnOrder(['closed', 'closed'])).toEqual([
      'closed',
      'backlog',
      'in-progress'
    ]);
  });

  test('shares query and label filtering across list and board presentations', () => {
    const issues = [
      issue(179, 'Responsive Issues', ['frontend', 'mobile']),
      issue(187, 'New issue modal', ['frontend']),
      issue(97, 'Image uploads', ['backend'])
    ];
    expect(filterIssues(issues, '#187', new Set())).toEqual([issues[1]]);
    expect(filterIssues(issues, 'responsive', new Set(['frontend']))).toEqual([issues[0]]);
    expect(filterIssues(issues, '', new Set(['backend', 'mobile']))).toEqual([
      issues[0],
      issues[2]
    ]);
    expect(topIssueLabels(issues)).toEqual(['frontend', 'backend', 'mobile']);
  });

  test('keeps GitHub-derived placement stable while filtering cards', () => {
    const issues = [
      issue(1, 'Generic issue'),
      issue(2, 'Active issue')
    ];
    const pullRequests = [pullRequest(22, [2])];
    const filtered = filterIssues(issues, '#2', new Set());

    expect(groupIssuesByColumn(issues, pullRequests).backlog).toEqual([issues[0]]);
    expect(groupIssuesByColumn(filtered, pullRequests)['in-progress']).toEqual([issues[1]]);
  });
});
