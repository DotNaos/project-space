import { describe, expect, test } from 'bun:test';

import {
  isIssueCreationPath,
  issueCreationPath,
  issueListPath
} from '../src/features/project-desktop/components/issue-creation-route';

describe('issue creation route', () => {
  const projectId = 'github:DotNaos/project-space';

  test('builds canonical creation and list paths', () => {
    expect(issueCreationPath(projectId)).toBe(
      '/projects/github%3ADotNaos%2Fproject-space/issues/new'
    );
    expect(issueListPath(projectId)).toBe(
      '/projects/github%3ADotNaos%2Fproject-space/issues'
    );
  });

  test('matches only the current project creation route', () => {
    expect(isIssueCreationPath(issueCreationPath(projectId), projectId)).toBe(true);
    expect(isIssueCreationPath(issueListPath(projectId), projectId)).toBe(false);
    expect(isIssueCreationPath('/projects/github%3ADotNaos%2Fother/issues/new', projectId)).toBe(false);
    expect(isIssueCreationPath(
      '/projects/github%3ADotNaos%2Fproject-space/issues/187',
      projectId
    )).toBe(false);
  });
});
