import { describe, expect, test } from 'bun:test';
import { retiredPullRequestPrototypeIterationResult } from '../server/pr-prototype-iteration-retirement';

describe('configured prototype iteration retirement', () => {
  test('does not inspect or start a Connector-backed development server', async () => {
    const request = {
      headSha: 'a'.repeat(40),
      pullRequestNumber: 650,
      repositoryFullName: 'DotNaos/project-space',
      surface: 'desktop-prototype' as const
    };

    expect(retiredPullRequestPrototypeIterationResult(request)).toMatchObject({
      action: 'none',
      evidence: {
        headSha: request.headSha,
        pullRequestNumber: request.pullRequestNumber,
        repositoryFullName: request.repositoryFullName
      },
      reasonCode: 'dev-server-undeclared',
      state: 'unavailable'
    });
  });
});
