import { describe, expect, test } from 'bun:test';

import {
  bodyWithGitHubIssueCreationMarker,
  gitHubIssueCreationMarker,
  preserveGitHubIssueCreationMarker,
  stripGitHubIssueCreationMarker
} from '../src/shared/github-issue-creation-marker';

const operationId = '00000000-0000-4000-8000-000000000187';
const marker = gitHubIssueCreationMarker(operationId);

describe('GitHub issue creation marker', () => {
  test('appends one exact marker and replaces an existing trailing marker', () => {
    expect(bodyWithGitHubIssueCreationMarker('Description', operationId)).toBe(
      `Description\n\n${marker}`
    );
    expect(bodyWithGitHubIssueCreationMarker(`Description\n\n${marker}`, operationId)).toBe(
      `Description\n\n${marker}`
    );
  });

  test('removes valid creation markers anywhere in browser-facing Markdown', () => {
    expect(stripGitHubIssueCreationMarker(`Description\n\n${marker}\n`)).toBe('Description');
    expect(stripGitHubIssueCreationMarker(`${marker}\n\nDescription`)).toBe('Description');
    expect(stripGitHubIssueCreationMarker(`Before\n\n${marker}\n\nAfter`)).toBe(
      'Before\n\n\n\nAfter'
    );
    expect(stripGitHubIssueCreationMarker('<!-- project-space-issue-create:not-a-uuid -->'))
      .toBe('<!-- project-space-issue-create:not-a-uuid -->');
  });

  test('keeps the current hidden marker across an ordinary body edit', () => {
    const otherMarker = gitHubIssueCreationMarker(
      '00000000-0000-4000-8000-000000000188'
    );

    expect(preserveGitHubIssueCreationMarker(
      `Updated description\n\n${otherMarker}`,
      `Old description\n\n${marker}\n\nText added on GitHub`
    )).toBe(`Updated description\n\n${marker}`);
    expect(preserveGitHubIssueCreationMarker('Updated description', 'Old description'))
      .toBe('Updated description');
  });
});
