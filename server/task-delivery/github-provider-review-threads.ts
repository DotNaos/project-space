import type {
  AuthorizedGitHubTarget,
  GitHubTaskDeliveryProviderDependencies
} from './github-provider-observation';

interface GitHubReviewThreadConnection {
  nodes?: Array<{ isResolved?: boolean | null } | null> | null;
  pageInfo?: { endCursor?: string | null; hasNextPage?: boolean | null } | null;
}

interface GitHubReviewThreadsQuery {
  repository?: {
    pullRequest?: { reviewThreads?: GitHubReviewThreadConnection | null } | null;
  } | null;
}

export async function readUnresolvedGitHubReviewThreadCount(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  pullRequestNumber: number
) {
  let after: string | null = null;
  let unresolvedThreads = 0;
  const seenCursors = new Set<string>();
  for (let page = 1; page <= 5; page += 1) {
    const result: GitHubReviewThreadsQuery =
      await dependencies.requestGitHubGraphQL<GitHubReviewThreadsQuery>(
        context.token,
        `query PullRequestReviewThreads(
          $owner: String!, $name: String!, $number: Int!, $after: String
        ) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes { isResolved }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }`,
        { after, name: context.repository.name, number: pullRequestNumber, owner: context.repository.owner }
      );
    const connection: GitHubReviewThreadConnection | null | undefined =
      result.repository?.pullRequest?.reviewThreads;
    const nodes: GitHubReviewThreadConnection['nodes'] = connection?.nodes;
    const pageInfo: GitHubReviewThreadConnection['pageInfo'] = connection?.pageInfo;
    if (!Array.isArray(nodes) || nodes.length > 100 || typeof pageInfo?.hasNextPage !== 'boolean' ||
        nodes.some((node) => !node || typeof node.isResolved !== 'boolean')) {
      throw new Error('GitHub review-thread evidence is incomplete.');
    }
    unresolvedThreads += nodes.filter((node) => node?.isResolved === false).length;
    if (!pageInfo.hasNextPage) return unresolvedThreads;
    const cursor: string | null | undefined = pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) {
      throw new Error('GitHub review-thread pagination is incomplete.');
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  throw new Error('GitHub review-thread evidence exceeds the pagination limit.');
}
