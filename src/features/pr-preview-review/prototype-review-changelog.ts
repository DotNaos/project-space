import type { PullRequestChangelogIdentity } from '../../shared/pr-preview-changelog-api';
import type { PullRequestTestSurfacesResult } from '../../shared/pr-preview-test-surfaces-api';
import type { PrototypeReviewLocalContext } from '../../shared/prototype-review-local-api';

export function prototypeReviewChangelogIdentity(input: {
  localContext?: PrototypeReviewLocalContext;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
}): PullRequestChangelogIdentity | undefined {
  const { localContext, pullRequestNumber, repositoryFullName, result } = input;
  if (!pullRequestNumber || !repositoryFullName) return undefined;
  if (
    localContext?.checkout.state === 'available' &&
    localContext.checkout.repositoryFullName.toLowerCase() === repositoryFullName.toLowerCase()
  ) {
    return {
      headSha: localContext.checkout.headSha,
      pullRequestNumber,
      repositoryFullName: localContext.checkout.repositoryFullName
    };
  }
  if (!result) return undefined;
  return {
    headSha: result.headSha,
    pullRequestNumber,
    repositoryFullName
  };
}
