import {
  isPullRequestChangelogIdentity,
  samePullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '../../shared/pr-preview-changelog-api';
import type { PullRequestTestSurfacesResult } from '../../shared/pr-preview-test-surfaces-api';
import type { PrototypeReviewLocalContext } from '../../shared/prototype-review-local-api';

export function prototypeReviewChangelogIdentity(input: {
  expectedIdentity?: PullRequestChangelogIdentity;
  localContext?: PrototypeReviewLocalContext;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
}): PullRequestChangelogIdentity | undefined {
  const {
    expectedIdentity,
    localContext,
    pullRequestNumber,
    repositoryFullName,
    result
  } = input;
  if (!pullRequestNumber || !repositoryFullName) return undefined;
  if (
    expectedIdentity &&
    (!isPullRequestChangelogIdentity(expectedIdentity) ||
      expectedIdentity.pullRequestNumber !== pullRequestNumber ||
      expectedIdentity.repositoryFullName.toLowerCase() !==
        repositoryFullName.toLowerCase())
  ) {
    return undefined;
  }
  if (
    localContext?.checkout.state === 'available' &&
    localContext.checkout.repositoryFullName.toLowerCase() === repositoryFullName.toLowerCase() &&
    (!expectedIdentity ||
      samePullRequestChangelogIdentity(expectedIdentity, {
        headSha: localContext.checkout.headSha,
        pullRequestNumber,
        repositoryFullName: localContext.checkout.repositoryFullName
      }))
  ) {
    const identity = {
      headSha: localContext.checkout.headSha,
      pullRequestNumber,
      repositoryFullName: localContext.checkout.repositoryFullName
    };
    return expectedIdentity ?? identity;
  }
  if (!result) return undefined;
  const resultIdentity = {
    headSha: result.headSha,
    pullRequestNumber,
    repositoryFullName
  };
  return expectedIdentity &&
    !samePullRequestChangelogIdentity(
      expectedIdentity,
      resultIdentity
    )
    ? undefined
    : expectedIdentity ?? resultIdentity;
}
