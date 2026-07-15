import { describe, expect, test } from 'bun:test';
import type { GitHubIssueRecord } from '../src/shared/project-space-api';
import {
  filterIssues,
  groupIssuesByColumn,
  issuePlacementIndices,
  normalizeIssueColumnOrder,
  resolveIssueColumn,
  resolveIssueColumnFromPlacement,
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

describe('issue board model', () => {
  test('keeps closed state authoritative over local placement', () => {
    const closed = issue(1, 'Done', ['ready'], 'closed');
    const reopened = issue(1, 'Reopened work');
    expect(resolveIssueColumn(closed, 0, { 1: 'in-progress' })).toBe('closed');
    expect(groupIssuesByColumn([closed], { 1: 'ready' }).closed).toEqual([closed]);
    expect(resolveIssueColumn(reopened, 4, { 1: 'closed' })).toBe('backlog');
  });

  test('normalizes board order without losing or duplicating columns', () => {
    expect(normalizeIssueColumnOrder(['closed', 'ready', 'ready'])).toEqual([
      'closed',
      'ready',
      'backlog',
      'in-progress',
      'blocked'
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

  test('keeps derived placement stable while filtering cards', () => {
    const issues = Array.from({ length: 5 }, (_, index) =>
      issue(index + 1, `Generic issue ${index + 1}`)
    );
    const filtered = filterIssues(issues, '#5', new Set());

    expect(groupIssuesByColumn(issues, {}).backlog).toEqual([issues[4]]);
    expect(groupIssuesByColumn(filtered, {}, issues).backlog).toEqual([issues[4]]);
    expect(groupIssuesByColumn(filtered, {}, issues).ready).toEqual([]);
    expect(
      resolveIssueColumnFromPlacement(
        filtered[0],
        0,
        {},
        issuePlacementIndices(issues)
      )
    ).toBe('backlog');
  });
});
