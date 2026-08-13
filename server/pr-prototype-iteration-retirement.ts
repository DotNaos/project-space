import type {
  PullRequestPrototypeIterationRequest,
  PullRequestPrototypeIterationResult
} from '../src/shared/pr-prototype-iteration-api';

export function retiredPullRequestPrototypeIterationResult(
  request: PullRequestPrototypeIterationRequest
): PullRequestPrototypeIterationResult {
  return {
    action: 'none',
    checkedAt: new Date().toISOString(),
    evidence: {
      headSha: request.headSha,
      pullRequestNumber: request.pullRequestNumber,
      repositoryFullName: request.repositoryFullName
    },
    reasonCode: 'dev-server-undeclared',
    state: 'unavailable'
  };
}
