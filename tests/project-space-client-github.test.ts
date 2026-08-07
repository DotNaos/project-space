import { describe, expect, test } from 'bun:test';
import { GitHubProjectSpaceClient } from '../src/api/project-space-client-github';
import type { GitHubBranchComparisonResult } from '../src/shared/project-space-api';

class RecordingGitHubClient extends GitHubProjectSpaceClient {
  requestRecord?: { init?: RequestInit; path: string };

  protected override request<Result>(path: string, init?: RequestInit): Promise<Result> {
    this.requestRecord = { init, path };
    return Promise.resolve({
      aheadBy: 1,
      checkedAt: '2026-08-07T08:00:00.000Z',
      commits: [],
      freshness: 'current',
      mergeBaseIncluded: false,
      status: 'connected',
      truncated: true
    } as Result);
  }
}

describe('Project Space GitHub client', () => {
  test('serializes the coherent issue-development start contract', async () => {
    const client = new RecordingGitHubClient();
    const request = {
      branchName: 'issue-494-starting-development',
      fullName: 'DotNaos/project-space',
      issueNumber: 494
    };

    await client.startGitHubIssueDevelopment(request);

    expect(client.requestRecord?.path).toBe('/api/github/issue-development');
    expect(client.requestRecord?.init?.method).toBe('POST');
    expect(JSON.parse(String(client.requestRecord?.init?.body))).toEqual(request);
  });

  test('serializes the linked-branch pre-PR comparison contract', async () => {
    const client = new RecordingGitHubClient();
    const request = {
      expectedHeadSha: 'a'.repeat(40),
      fullName: 'DotNaos/project-space',
      headBranch: 'issue-473-release-tag-queue-no-conflicts',
      limit: 1 as const
    };

    const result: GitHubBranchComparisonResult = await client.getGitHubBranchComparison(request);

    expect(result.aheadBy).toBe(1);
    expect(client.requestRecord?.path).toBe('/api/github/branch-comparison');
    expect(client.requestRecord?.init?.method).toBe('POST');
    expect(JSON.parse(String(client.requestRecord?.init?.body))).toEqual(request);
  });
});
